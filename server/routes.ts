import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, isAuthenticated } from "./stytchAuth";
import { sendChatInvitation, sendTeamInvitation, sendInvoiceEmail } from "./resend";
// Removed PDF generator import - now using hosted pages approach
import { randomBytes } from "crypto";
import { z } from "zod";
import { calculateTrialEndDate } from "../shared/trial";
import { calculateInvoiceTotals, validateLineItems, TAX_OPTIONS, type LineItem } from "./utils/calculations";
import { getPusher, triggerChannelEvent } from "./pusher";
import { createRfpMagicLinkToken, consumeRfpMagicLinkToken } from "./rfpMagicLinks";
import {
  ensureChannelWithMembers,
  ensureStreamUser,
  encodeStreamIdentifier,
  getStreamChatServer,
  getStreamEnvironment,
  getStreamFeedClient,
  sanitizeImageValue,
  type StreamIdentity,
} from "./stream";
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

const toCents = (value?: number | null) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return 0;
  }
  return Math.round(Number(value) * 100);
};


const lineItemInputSchema = z.object({
  description: z.string().min(1, "Description is required"),
  quantity: z.coerce.number().int().min(1).default(1),
  unitPrice: z.coerce.number().nonnegative().default(0),
  totalPrice: z.coerce.number().nonnegative().optional(),
  category: z.string().optional(),
});

const purchaseInvoiceInputSchema = z.object({
  vendorId: z.string().min(1),
  poId: z.string().optional().nullable(),
  invoiceNumber: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional().nullable(),
  totalAmount: z.coerce.number().nonnegative(),
  taxAmount: z.coerce.number().nonnegative().optional().default(0),
  currency: z.string().optional(),
  invoiceDate: z.string(),
  dueDate: z.string().optional().nullable(),
  status: z.string().optional(),
  receiptImageUrl: z.string().optional().nullable(),
  ocrData: z.any().optional(),
  lineItems: z.array(lineItemInputSchema).optional(),
});

const vendorInvoiceSubmissionSchema = z.object({
  vendorId: z.string().min(1),
  rfpId: z.string().min(1),
  invoiceNumber: z.string().optional(),
  amount: z.coerce.number().positive(),
  invoiceDate: z.string(),
  dueDate: z.string().optional().nullable(),
  contactEmail: z.string().email(),
  description: z.string().optional().nullable(),
  fileDataUrl: z.string().optional().nullable(),
  fileName: z.string().optional().nullable(),
});

// Helper to generate random tokens
function generateToken(length: number = 32): string {
  return randomBytes(length).toString("hex");
}

function generatePasscode(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

function generateSlug(): string {
  return randomBytes(8).toString("hex");
}

function generateInvoiceNumber(workspaceId: string): string {
  const timestamp = Date.now().toString().slice(-8); // Last 8 digits of timestamp
  const random = Math.random().toString(36).substring(2, 6).toUpperCase(); // 4 random chars
  return `INV-${timestamp}-${random}`;
}

const parseDateInput = (raw?: string | null) => {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const isProduction = process.env.NODE_ENV === "production";
const getRfpChatCookieName = (rfpId: string) => `rfp_chat_${rfpId}`;
const getIssueChatCookieName = (issueId: string) => `issue_chat_${issueId}`;

function readRfpVendorCookie(req: any, rfpId: string) {
  const cookie = req.cookies?.[getRfpChatCookieName(rfpId)];
  if (!cookie) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cookie, "base64").toString());
    if (parsed?.email && typeof parsed.email === "string") {
      return parsed.email.toLowerCase();
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveRfpChatViewer(req: any, rfp: any) {
  const vendorEmail = readRfpVendorCookie(req, rfp.id);
  if (vendorEmail) {
    return { type: "vendor" as const, email: vendorEmail };
  }
  const userId = req.user?.claims?.sub;
  if (userId) {
    const user = await storage.getUser(userId);
    if (user?.workspaceId && user.workspaceId === rfp.workspaceId) {
      return { type: "internal" as const, user };
    }
  }
  return { type: "anonymous" as const };
}

function readIssueChatCookie(req: any, issueId: string) {
  const cookie = req.cookies?.[getIssueChatCookieName(issueId)];
  if (!cookie) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cookie, "base64").toString());
    if (parsed && typeof parsed === "object") {
      return {
        name: typeof parsed.name === "string" ? parsed.name : undefined,
        email: typeof parsed.email === "string" ? parsed.email : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveIssueChatViewer(req: any, issue: any) {
  const cookie = readIssueChatCookie(req, issue.id);
  if (cookie?.name) {
    return { type: "contact" as const, ...cookie };
  }
  const userId = req.user?.claims?.sub;
  if (userId) {
    const user = await storage.getUser(userId);
    if (user?.workspaceId && user.workspaceId === issue.workspaceId) {
      return { type: "internal" as const, user };
    }
  }
  return { type: "anonymous" as const };
}

function normalizeStreamActor(actor: any) {
  if (!actor) {
    return { id: "unknown", name: "Unknown" };
  }
  if (typeof actor === "string") {
    const [, rawId] = actor.split(":");
    return { id: rawId || actor, name: rawId || "Unknown" };
  }
  const id = actor.id || actor.data?.id || "unknown";
  const name = actor.name || actor.data?.name || "Unknown";
  const image = actor.image || actor.data?.image || actor.data?.profileImage || null;
  return { id, name, image };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Auth middleware
  await setupAuth(app);

  // Auth routes
  app.get("/api/auth/user", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      res.json(user);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  app.get("/api/rfp/chat/verify", async (req: any, res) => {
    try {
      const { token, email, id } = req.query as { token?: string; email?: string; id?: string };
      if (!token || !email || !id) {
        return res.status(400).json({ message: "Missing token, email, or id" });
      }

      const rfp = await storage.getRfp(id);
      if (!rfp) {
        return res.status(404).json({ message: "RFP not found" });
      }

      const valid = consumeRfpMagicLinkToken(token, id, email);
      if (!valid) {
        return res.status(401).json({ message: "Invalid or expired magic link" });
      }

      const cookieValue = Buffer.from(JSON.stringify({ email: email.toLowerCase() })).toString("base64");
      res.cookie(getRfpChatCookieName(id), cookieValue, {
        httpOnly: true,
        sameSite: "lax",
        secure: isProduction,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error verifying RFP chat link:", error);
      res.status(500).json({ message: "Failed to verify magic link" });
    }
  });

  // Onboarding
  app.post("/api/onboarding/complete", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const { user: userData, workspace: workspaceData, dealsData } = req.body;

      console.log('Onboarding request received:', {
        userId,
        hasUserData: !!userData,
        hasWorkspaceData: !!workspaceData,
        hasDealsData: !!dealsData,
        dealsDataLength: dealsData?.length || 0,
        dealsDataType: typeof dealsData,
        isDealsDataArray: Array.isArray(dealsData)
      });

      let userWorkspaceId = null;

      // If creating new workspace
      if (workspaceData) {
        const now = new Date();
        const workspace = await storage.createWorkspace({
          name: workspaceData.companyName,
          billingEmail: workspaceData.billingEmail,
          industry: workspaceData.industry,
          bio: workspaceData.bio,
          logoUrl: workspaceData.logoUrl,
          createdById: userId,
          subscriptionStatus: 'trial',
          trialEndDate: calculateTrialEndDate(now),
        });

        console.log('Workspace created:', workspace.id);

        // Update user with workspace and make them admin
        await storage.updateUser(userId, {
          firstName: userData.firstName,
          lastName: userData.lastName,
          role: userData.role,
          teamName: userData.teamName,
          profileImageUrl: userData.profileImageUrl,
          workspaceId: workspace.id,
          isAdmin: true,
          onboardingCompleted: true,
        });
        userWorkspaceId = workspace.id;
      } else {
        // Just updating user profile (invited user)
        await storage.updateUser(userId, {
          firstName: userData.firstName,
          lastName: userData.lastName,
          role: userData.role,
          teamName: userData.teamName,
          profileImageUrl: userData.profileImageUrl,
          onboardingCompleted: true,
        });
      }

      // Process deals data if provided
      if (dealsData && Array.isArray(dealsData) && dealsData.length > 0) {
        console.log('Processing deals data:', dealsData.length, 'deals');
        
        const user = await storage.getUser(userId);
        console.log('User after workspace update:', { 
          id: user?.id, 
          workspaceId: user?.workspaceId,
          email: user?.email 
        });
        
        if (user?.workspaceId) {
          try {
            console.log('Creating issues for workspace:', user.workspaceId);
            
            // Use the existing bulk creation logic
            const createdIssues = [];
            let dealErrors = [];

            for (const dealData of dealsData) {
              try {
                console.log('Creating deal:', dealData.title || 'Untitled Deal');
                
                // Convert dealValue to integer if it's a string
                let dealValue = null;
                if (dealData.dealValue) {
                  dealValue = parseInt(dealData.dealValue.toString()) || null;
                }
                
                const issue = await storage.createIssue({
                  workspaceId: user.workspaceId,
                  title: dealData.title || 'Untitled Deal',
                  description: dealData.description || '',
                  contactName: dealData.contactName || '',
                  contactEmail: dealData.contactEmail || '',
                  contactCompany: dealData.contactCompany || '',
                  dealValue: dealValue,
                  labels: dealData.labels || [],
                  createdById: userId,
                  status: dealData.status || "open",
                });

                console.log('Deal created successfully:', issue.id, issue.title);

                // Log activity
                await storage.createActivity({
                  issueId: issue.id,
                  userId,
                  action: "created",
                });

                const issueWithDetails = await storage.getIssueWithDetails(issue.id);
                createdIssues.push(issueWithDetails);
              } catch (dealError) {
                console.error("Error creating individual deal:", dealError);
                dealErrors.push({ dealData, error: (dealError as Error).message });
                // Continue with other deals even if one fails
              }
            }

            console.log(`Successfully created ${createdIssues.length} deals out of ${dealsData.length} during onboarding`);
            if (dealErrors.length > 0) {
              console.log('Deal creation errors:', dealErrors);
            }
          } catch (bulkError) {
            console.error("Error creating deals during onboarding:", bulkError);
            // Don't fail the entire onboarding if deals creation fails
          }
        } else {
          console.warn("No workspace found for user, skipping deals creation");
        }
      } else {
        console.log('No deals data to process');
      }

      const updatedUser = await storage.getUser(userId);
      if (updatedUser) {
        console.log('Onboarding completed successfully for user:', updatedUser.id);
      }
      res.json(updatedUser);
    } catch (error) {
      console.error("Error completing onboarding:", error);
      res.status(500).json({ message: "Failed to complete onboarding" });
    }
  });

  // Dashboard stats
  app.get("/api/dashboard/stats", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json({ openIssues: 0, closedIssues: 0, totalValue: 0, teamMembers: 0 });
      }
      const stats = await storage.getDashboardStats(user.workspaceId);
      res.json(stats);
    } catch (error) {
      console.error("Error fetching dashboard stats:", error);
      res.status(500).json({ message: "Failed to fetch stats" });
    }
  });

  // Recent activities
  app.get("/api/activities/recent", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json([]);
      }
      const activities = await storage.getRecentActivities(user.workspaceId);
      res.json(activities);
    } catch (error) {
      console.error("Error fetching activities:", error);
      res.status(500).json({ message: "Failed to fetch activities" });
    }
  });

  // Issues
  app.get("/api/issues", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json([]);
      }
      const status = req.query.status as string | undefined;
      const issues = await storage.getIssuesByWorkspace(user.workspaceId, status);
      res.json(issues);
    } catch (error) {
      console.error("Error fetching issues:", error);
      res.status(500).json({ message: "Failed to fetch issues" });
    }
  });

  app.get("/api/issues/:id", isAuthenticated, async (req: any, res) => {
    try {
      const issue = await storage.getIssueWithDetails(req.params.id);
      if (!issue) {
        return res.status(404).json({ message: "Issue not found" });
      }
      res.json(issue);
    } catch (error) {
      console.error("Error fetching issue:", error);
      res.status(500).json({ message: "Failed to fetch issue" });
    }
  });

  app.get("/api/issues/:id/team-chat", isAuthenticated, async (req: any, res) => {
    try {
      const issue = await storage.getIssueWithDetails(req.params.id);
      if (!issue) {
        return res.status(404).json({ message: "Issue not found" });
      }
      const teamMembers = issue.workspaceId
        ? await storage.getUsersByWorkspace(issue.workspaceId)
        : [];
      res.json({
        issue,
        comments: await storage.getCommentsByIssue(issue.id),
        teamMembers,
      });
    } catch (error) {
      console.error("Error fetching team chat:", error);
      res.status(500).json({ message: "Failed to fetch team chat" });
    }
  });

  app.post("/api/issues", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.status(400).json({ message: "User not in a workspace" });
      }

      // Convert dealValue to integer if it's a string
      let dealValue = null;
      if (req.body.dealValue) {
        dealValue = parseInt(req.body.dealValue.toString()) || null;
      }

      const issue = await storage.createIssue({
        workspaceId: user.workspaceId,
        title: req.body.title,
        description: req.body.description,
        contactName: req.body.contactName,
        contactEmail: req.body.contactEmail,
        contactCompany: req.body.contactCompany,
        dealValue: dealValue,
        labels: req.body.labels,
        createdById: userId,
        status: "open",
      });

      // Log activity
      await storage.createActivity({
        issueId: issue.id,
        userId,
        action: "created",
      });

      const issueWithDetails = await storage.getIssueWithDetails(issue.id);
      res.json(issueWithDetails);
    } catch (error) {
      console.error("Error creating issue:", error);
      res.status(500).json({ message: "Failed to create issue" });
    }
  });

  app.post("/api/issues/bulk", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.status(400).json({ message: "User not in a workspace" });
      }

      const issues = req.body.issues;
      if (!Array.isArray(issues)) {
        return res.status(400).json({ message: "issues must be an array" });
      }

      if (issues.length === 0) {
        return res.status(400).json({ message: "issues array cannot be empty" });
      }

      if (issues.length > 100) {
        return res.status(400).json({ message: "Cannot create more than 100 issues at once" });
      }

      const createdIssues = [];

      for (const issueData of issues) {
        try {
          // Convert dealValue to integer if it's a string
          let dealValue = null;
          if (issueData.dealValue) {
            dealValue = parseInt(issueData.dealValue.toString()) || null;
          }
          
          const issue = await storage.createIssue({
            workspaceId: user.workspaceId,
            title: issueData.title,
            description: issueData.description,
            contactName: issueData.contactName,
            contactEmail: issueData.contactEmail,
            contactCompany: issueData.contactCompany,
            dealValue: dealValue,
            labels: issueData.labels,
            createdById: userId,
            status: issueData.status || "open",
          });

          // Log activity
          await storage.createActivity({
            issueId: issue.id,
            userId,
            action: "created",
          });

          const issueWithDetails = await storage.getIssueWithDetails(issue.id);
          createdIssues.push(issueWithDetails);
        } catch (error) {
          console.error("Error creating issue in bulk:", error);
          // Continue with other issues even if one fails
        }
      }

      res.json({
        created: createdIssues.length,
        issues: createdIssues,
        totalRequested: issues.length
      });
    } catch (error) {
      console.error("Error creating issues in bulk:", error);
      res.status(500).json({ message: "Failed to create issues" });
    }
  });

  app.patch("/api/issues/:id", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      await storage.updateIssue(req.params.id, req.body);

      if (req.body.status) {
        await storage.createActivity({
          issueId: req.params.id,
          userId,
          action: "status_changed",
          metadata: { newStatus: req.body.status },
        });
      }

      const issueWithDetails = await storage.getIssueWithDetails(req.params.id);
      res.json(issueWithDetails);
    } catch (error) {
      console.error("Error updating issue:", error);
      res.status(500).json({ message: "Failed to update issue" });
    }
  });

  app.delete("/api/issues/:id", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.status(403).json({ message: "User not in a workspace" });
      }

      const issue = await storage.getIssue(req.params.id);
      if (!issue) {
        return res.status(404).json({ message: "Issue not found" });
      }

      if (issue.workspaceId !== user.workspaceId) {
        return res.status(403).json({ message: "Not authorized to delete this issue" });
      }

      await storage.deleteIssue(issue.id);
      await storage.createActivity({
        issueId: issue.id,
        userId,
        action: "deleted",
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting issue:", error);
      res.status(500).json({ message: "Failed to delete issue" });
    }
  });

  // Comments
  app.post("/api/issues/:id/comments", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);

      const comment = await storage.createComment({
        issueId: req.params.id,
        authorId: userId,
        content: req.body.content,
        isClientComment: false,
      });

      await storage.createActivity({
        issueId: req.params.id,
        userId,
        action: "commented",
      });

      res.json(comment);
    } catch (error) {
      console.error("Error creating comment:", error);
      res.status(500).json({ message: "Failed to create comment" });
    }
  });

  app.delete("/api/issues/:id/comments/:commentId", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const { id: issueId, commentId } = req.params;

      // Get user to check authorization
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }

      // For now, only admins can delete comments (prevent accidental deletion)
      if (!user.isAdmin) {
        return res.status(403).json({ message: "Only admins can delete comments" });
      }

      // Delete the comment via database
      const { db } = await import("./db");
      const { comments } = await import("../shared/schema");
      const { eq } = await import("drizzle-orm");
      
      const [comment] = await db.select().from(comments).where(eq(comments.id, commentId));
      
      if (!comment) {
        return res.status(404).json({ message: "Comment not found" });
      }

      await db.delete(comments).where(eq(comments.id, commentId));

      await storage.createActivity({
        issueId,
        userId,
        action: "deleted_comment",
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting comment:", error);
      res.status(500).json({ message: "Failed to delete comment" });
    }
  });

  app.get("/api/issues/:id/feed", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      const issue = await storage.getIssue(req.params.id);
      if (!issue) {
        return res.status(404).json({ message: "Issue not found" });
      }
      if (!user?.workspaceId || user.workspaceId !== issue.workspaceId) {
        return res.status(403).json({ message: "Not authorized" });
      }

      const feedClient = getStreamFeedClient();
      if (!feedClient) {
        return res.status(503).json({ message: "Activity feed is not configured" });
      }

      const feed = feedClient.feed("issue", issue.id);
      const response = await feed.get({ limit: 50, enrich: true });
      const entries = response.results.map((activity: any) => {
        const actor = normalizeStreamActor(activity.actor);
        return {
          id: activity.id,
          text: activity.text || activity.message || "",
          createdAt: activity.time,
          actor,
          mentions: activity.mentions || [],
          attachments: activity.attachments || [],
        };
      });

      res.json(entries);
    } catch (error) {
      console.error("Error fetching issue feed:", error);
      res.status(500).json({ message: "Failed to load activity feed" });
    }
  });

  app.post("/api/issues/:id/feed", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      const issue = await storage.getIssue(req.params.id);

      if (!issue) {
        return res.status(404).json({ message: "Issue not found" });
      }
      if (!user?.workspaceId || user.workspaceId !== issue.workspaceId) {
        return res.status(403).json({ message: "Not authorized" });
      }

      const { content } = req.body || {};
      if (!content || typeof content !== "string" || !content.trim()) {
        return res.status(400).json({ message: "Content is required" });
      }

      const feedClient = getStreamFeedClient();
      if (!feedClient) {
        return res.status(503).json({ message: "Activity feed is not configured" });
      }

      const identity: StreamIdentity = {
        id: user.id,
        name:
          `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
          user.email ||
          "Workspace user",
        image: sanitizeImageValue(user.profileImageUrl),
        email: user.email,
      };
      await ensureStreamUser(identity);

      const mentions = Array.from(content.matchAll(/@(\w+)/g)).map((match) => match[1]);

      const feed = feedClient.feed("issue", issue.id);
      const activity = await feed.addActivity({
        actor: `user:${user.id}`,
        verb: "note",
        object: `issue:${issue.id}`,
        text: content.trim(),
        issueId: issue.id,
        mentions,
      });

      res.json({
        id: activity.id,
        text: activity.text,
        createdAt: activity.time,
        actor: identity,
        mentions,
      });
    } catch (error) {
      console.error("Error posting to issue feed:", error);
      res.status(500).json({ message: "Failed to post to feed" });
    }
  });

  app.delete("/api/issues/:issueId/feed/:activityId", isAuthenticated, async (req: any, res) => {
    try {
      const { issueId, activityId } = req.params;
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      const issue = await storage.getIssue(issueId);
      if (!issue) {
        return res.status(404).json({ message: "Issue not found" });
      }
      if (!user?.workspaceId || user.workspaceId !== issue.workspaceId) {
        return res.status(403).json({ message: "Not authorized" });
      }
      if (!user.isAdmin) {
        return res.status(403).json({ message: "Only admins can delete feed entries" });
      }

      const feedClient = getStreamFeedClient();
      if (!feedClient) {
        return res.status(503).json({ message: "Activity feed is not configured" });
      }

      const feed = feedClient.feed("issue", issue.id);
      await feed.removeActivity(activityId);
      res.status(204).end();
    } catch (error) {
      console.error("Error deleting issue feed activity:", error);
      res.status(500).json({ message: "Failed to delete activity" });
    }
  });

  // Publish issue
  app.post("/api/issues/:id/publish", isAuthenticated, async (req: any, res) => {
    try {
      const issue = await storage.getIssue(req.params.id);
      if (!issue) {
        return res.status(404).json({ message: "Issue not found" });
      }

      const passcode = generatePasscode();
      const slug = generateSlug();

      await storage.updateIssue(req.params.id, {
        isPublished: true,
        publishedPasscode: passcode,
        publishedSlug: slug,
      });

      // Send email if provided
      if (req.body.email) {
        const protocol = req.protocol;
        const host = req.get("host");
        const chatLink = `${protocol}://${host}/chat/${slug}`;
        
        try {
          await sendChatInvitation(req.body.email, chatLink, passcode, issue.title);
        } catch (emailError) {
          console.error("Failed to send email:", emailError);
          // Continue even if email fails
        }
      }

      res.json({ slug, passcode });
    } catch (error) {
      console.error("Error publishing issue:", error);
      res.status(500).json({ message: "Failed to publish issue" });
    }
  });

  app.post("/api/issues/:id/unpublish", isAuthenticated, async (req: any, res) => {
    try {
      await storage.updateIssue(req.params.id, {
        isPublished: false,
        publishedPasscode: null,
        publishedSlug: null,
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Error unpublishing issue:", error);
      res.status(500).json({ message: "Failed to unpublish issue" });
    }
  });

  app.post("/api/pusher/auth", (req, res) => {
    const pusher = getPusher();
    if (!pusher) {
      return res.status(503).json({ message: "Realtime service is disabled" });
    }

    const socketId = req.body?.socket_id || req.body?.socketId;
    const channelName = req.body?.channel_name || req.body?.channelName;

    if (!socketId || !channelName) {
      return res.status(400).json({ message: "Missing socket or channel identifiers" });
    }

    const {
      participantId,
      participantName,
      participantEmail,
      participantAvatar,
    } = req.query as Record<string, string | undefined>;

    const userId =
      (participantId && participantId.toString()) ||
      (participantEmail && participantEmail.toString()) ||
      generateToken(6);

    const displayName =
      (participantName && participantName.toString()) ||
      (participantEmail && participantEmail.toString()) ||
      "Guest";

    const presenceData = {
      user_id: userId,
      user_info: {
        name: displayName,
        email: participantEmail,
        avatar: participantAvatar,
      },
    };

    try {
      if (channelName.startsWith("presence-")) {
        const auth = pusher.authorizeChannel(socketId, channelName, presenceData);
        return res.send(auth);
      }

      if (channelName.startsWith("private-")) {
        const auth = pusher.authorizeChannel(socketId, channelName);
        return res.send(auth);
      }

      return res.status(400).json({ message: "Unsupported channel type" });
    } catch (error) {
      console.error("Pusher auth error:", error);
      return res.status(500).json({ message: "Failed to authorize channel" });
    }
  });

  // Public chat routes (no auth required, but passcode protected)
  app.get("/api/chat/:slug/auth-check", (req, res) => {
    const cookieName = `chat_${req.params.slug}`;
    const cookie = req.cookies?.[cookieName];
    
    if (cookie) {
      try {
        const data = JSON.parse(Buffer.from(cookie, "base64").toString());
        res.json({ authenticated: true, clientName: data.name });
      } catch {
        res.json({ authenticated: false });
      }
    } else {
      res.json({ authenticated: false });
    }
  });

  app.post("/api/chat/:slug/verify", async (req, res) => {
    try {
      const issue = await storage.getIssueBySlug(req.params.slug);
      if (!issue || !issue.isPublished) {
        return res.status(404).json({ message: "Chat not found" });
      }

      if (issue.publishedPasscode !== req.body.passcode) {
        return res.status(401).json({ message: "Invalid passcode" });
      }

      // Set cookie
      const cookieName = `chat_${req.params.slug}`;
      const cookieValue = Buffer.from(JSON.stringify({ name: req.body.name })).toString("base64");

      res.cookie(cookieName, cookieValue, {
        httpOnly: true,
        secure: true,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 1 week
      });

      res.json({
        success: true,
        contactEmail: issue.contactEmail,
        issueId: issue.id
      });
    } catch (error) {
      console.error("Error verifying passcode:", error);
      res.status(500).json({ message: "Failed to verify" });
    }
  });

  app.get("/api/chat/:slug", async (req, res) => {
    try {
      const issue = await storage.getIssueBySlug(req.params.slug);
      if (!issue || !issue.isPublished) {
        return res.status(404).json({ message: "Chat not found" });
      }

      const comments = await storage.getCommentsByIssue(issue.id);
      const teamMembers = issue.workspaceId
        ? await storage.getUsersByWorkspace(issue.workspaceId)
        : [];

      res.json({
        issue,
        comments,
        teamMembers,
      });
    } catch (error) {
      console.error("Error fetching chat:", error);
      res.status(500).json({ message: "Failed to fetch chat" });
    }
  });

  app.post("/api/chat/:slug/message", async (req, res) => {
    try {
      const issue = await storage.getIssueBySlug(req.params.slug);
      if (!issue || !issue.isPublished) {
        return res.status(404).json({ message: "Chat not found" });
      }

      const comment = await storage.createComment({
        issueId: issue.id,
        authorName: req.body.authorName,
        content: req.body.content,
        isClientComment: true,
      });

      res.json(comment);
    } catch (error) {
      console.error("Error sending message:", error);
      res.status(500).json({ message: "Failed to send message" });
    }
  });

  app.get("/api/chat/customer/auth", (req, res) => {
    const { issueId } = req.query as { issueId?: string };
    if (!issueId) {
      return res.status(400).json({ message: "issueId is required" });
    }
    const cookie = readIssueChatCookie(req, issueId);
    if (!cookie) {
      return res.json({ authenticated: false });
    }
    res.json({
      authenticated: true,
      name: cookie.name,
      email: cookie.email,
    });
  });

  app.post("/api/chat/customer/verify", async (req, res) => {
    try {
      const { issueId, passcode, name, email } = req.body || {};
      if (!issueId || !passcode || !name) {
        return res.status(400).json({ message: "issueId, name, and passcode are required" });
      }
      const issue = await storage.getIssue(issueId);
      if (!issue || !issue.isPublished) {
        return res.status(404).json({ message: "Chat not found" });
      }
      if (issue.publishedPasscode !== passcode) {
        return res.status(401).json({ message: "Invalid passcode" });
      }

      const cookieValue = Buffer.from(
        JSON.stringify({ name, email: typeof email === "string" ? email.toLowerCase() : undefined }),
      ).toString("base64");

      res.cookie(getIssueChatCookieName(issue.id), cookieValue, {
        httpOnly: true,
        sameSite: "lax",
        secure: isProduction,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.json({
        success: true,
        contactEmail: issue.contactEmail,
        issueId: issue.id,
      });
    } catch (error) {
      console.error("Error verifying customer chat:", error);
      res.status(500).json({ message: "Failed to verify chat access" });
    }
  });

  app.get("/api/stream/chat/customer", async (req: any, res) => {
    try {
      const { issueId } = req.query as { issueId?: string };
      if (!issueId) {
        return res.status(400).json({ message: "issueId is required" });
      }

      const issue = await storage.getIssueWithDetails(issueId);
      if (!issue || !issue.isPublished) {
        return res.status(404).json({ message: "Chat not found" });
      }

      const viewer = await resolveIssueChatViewer(req, issue);
      if (viewer.type === "anonymous") {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const chat = getStreamChatServer();
      const streamEnv = getStreamEnvironment();
      if (!chat || !streamEnv.key) {
        return res.status(503).json({ message: "Stream chat is not configured" });
      }

      const viewerIdentity =
        viewer.type === "internal"
          ? {
              id: viewer.user.id,
              name:
                `${viewer.user.firstName || ""} ${viewer.user.lastName || ""}`.trim() ||
                viewer.user.email ||
                "Workspace user",
              image: sanitizeImageValue(viewer.user.profileImageUrl),
              email: viewer.user.email,
            }
          : {
              id: encodeStreamIdentifier(
                `issue-${issue.id}-contact`,
                viewer.email || viewer.name || `guest-${Date.now()}`,
              ),
              name: viewer.name || viewer.email || "Guest",
              email: viewer.email,
            };

      const teamIdentities: StreamIdentity[] = [];
      const identityDirectory = new Map<string, StreamIdentity>();
      const registerIdentity = (identity?: StreamIdentity | null) => {
        if (!identity) return;
        identityDirectory.set(identity.id, identity);
      };

      const seenInternal = new Set<string>();
      const pushInternal = (user: any) => {
        if (!user?.id || seenInternal.has(user.id)) return;
        seenInternal.add(user.id);
        const identity: StreamIdentity = {
          id: user.id,
          name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "Workspace user",
          image: sanitizeImageValue(user.profileImageUrl),
          email: user.email,
        };
        teamIdentities.push(identity);
        registerIdentity(identity);
      };

      if (issue.createdBy) {
        pushInternal(issue.createdBy);
      }
      (issue.assignees || []).forEach((assignee: any) => pushInternal(assignee));

      let contactIdentity: StreamIdentity | null = null;
      if (viewer.type === "contact") {
        contactIdentity = {
          ...viewerIdentity,
          image: sanitizeImageValue(viewerIdentity.image),
        };
      } else if (issue.contactEmail || issue.contactName) {
        contactIdentity = {
          id: encodeStreamIdentifier(
            `issue-${issue.id}-contact`,
            issue.contactEmail || issue.contactName || "contact",
          ),
          name: issue.contactName || issue.contactEmail || "Client",
          email: issue.contactEmail || undefined,
          image: sanitizeImageValue(issue.createdBy?.clientLogoUrl),
        };
      }

      registerIdentity(viewerIdentity);
      registerIdentity(contactIdentity);

      await Promise.all(
        Array.from(identityDirectory.values()).map(async (identity) => ensureStreamUser(identity)),
      );

      const memberIds = new Set<string>();
      teamIdentities.forEach((identity) => memberIds.add(identity.id));
      if (contactIdentity) {
        memberIds.add(contactIdentity.id);
      }

      const channelId = encodeStreamIdentifier("issue", issue.id);
      const createdById =
        viewer.type === "internal"
          ? viewer.user.id
          : teamIdentities[0]?.id || contactIdentity?.id || viewerIdentity.id;

      const channel = chat.channel("messaging", channelId, {
        name: issue.chatTitle || issue.title,
        issue_id: issue.id,
        issue_number: issue.issueNumber,
        workspace_id: issue.workspaceId,
        created_by_id: createdById,
      });
      await ensureChannelWithMembers(channel, Array.from(memberIds));

      const token = chat.createToken(viewerIdentity.id);

      res.json({
        apiKey: streamEnv.key,
        appId: streamEnv.appId,
        token,
        user: viewerIdentity,
        channel: {
          id: channelId,
          type: "messaging",
          name: issue.chatTitle || issue.title,
          data: {
            issueId: issue.id,
            issueNumber: issue.issueNumber,
            workspaceId: issue.workspaceId,
          },
        },
        context: {
          type: "customer",
          issue: {
            id: issue.id,
            title: issue.title,
            issueNumber: issue.issueNumber,
            status: issue.status,
            contactName: issue.contactName,
            contactEmail: issue.contactEmail,
            contactCompany: issue.contactCompany,
          },
          contact: contactIdentity,
          team: teamIdentities,
        },
      });
    } catch (error) {
      console.error("Error loading customer chat:", error);
      res.status(500).json({ message: "Failed to load chat" });
    }
  });

  app.get("/api/stream/chat/vendor", async (req: any, res) => {
    try {
      const { rfpId, email } = req.query as { rfpId?: string; email?: string };
      if (!rfpId) {
        return res.status(400).json({ message: "rfpId is required" });
      }

      const rfp = await storage.getRfp(rfpId);
      if (!rfp) {
        return res.status(404).json({ message: "RFP not found" });
      }

      const viewer = await resolveRfpChatViewer(req, rfp);
      if (viewer.type === "anonymous") {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const vendorEmailRaw =
        viewer.type === "vendor"
          ? viewer.email
          : typeof email === "string"
          ? email
          : undefined;

      if (!vendorEmailRaw) {
        return res.status(400).json({ message: "Vendor email is required" });
      }

      if (vendorEmailRaw.length > 320) {
        return res.status(400).json({ message: "Email is too long" });
      }

      const vendorEmail = vendorEmailRaw.toLowerCase();

      const vendorRecord = await storage.getVendorByEmail(vendorEmail);
      const proposals = await storage.getProposalsByRfpAndEmail(rfpId, vendorEmail);
      if (viewer.type === "vendor" && proposals.length === 0) {
        return res.status(403).json({ message: "No proposal found for this email" });
      }

      const latestProposal = proposals[0];
      const vendorIdentity: StreamIdentity = {
        id: vendorRecord?.id || encodeStreamIdentifier(`vendor-${rfpId}`, vendorEmail),
        name:
          vendorRecord?.name ||
          latestProposal?.company ||
          vendorEmail.split("@")[0] ||
          "Vendor",
        image: sanitizeImageValue(vendorRecord?.logoUrl || latestProposal?.vendorLogoUrl || undefined),
        email: vendorEmail,
      };

      const chat = getStreamChatServer();
      const streamEnv = getStreamEnvironment();
      if (!chat || !streamEnv.key) {
        return res.status(503).json({ message: "Stream chat is not configured" });
      }

      const viewerIdentity =
        viewer.type === "internal"
          ? {
              id: viewer.user.id,
              name:
                `${viewer.user.firstName || ""} ${viewer.user.lastName || ""}`.trim() ||
                viewer.user.email ||
                "Workspace user",
              image: sanitizeImageValue(viewer.user.profileImageUrl),
              email: viewer.user.email,
            }
          : vendorIdentity;

      const identityDirectory = new Map<string, StreamIdentity>();
      const registerIdentity = (identity?: StreamIdentity | null) => {
        if (!identity) return;
        identityDirectory.set(identity.id, identity);
      };

      const teamMembersRaw = await storage.getUsersByWorkspace(rfp.workspaceId);
      const teamIdentities: StreamIdentity[] = teamMembersRaw.map((member) => ({
        id: member.id,
        name:
          `${member.firstName || ""} ${member.lastName || ""}`.trim() ||
          member.email ||
          "Workspace user",
        image: sanitizeImageValue(member.profileImageUrl),
        email: member.email,
      }));
      teamIdentities.forEach((identity) => registerIdentity(identity));

      registerIdentity(vendorIdentity);
      registerIdentity(viewerIdentity);

      await Promise.all(
        Array.from(identityDirectory.values()).map(async (identity) => ensureStreamUser(identity)),
      );

      const memberIds = new Set<string>();
      teamIdentities.forEach((identity) => memberIds.add(identity.id));
      memberIds.add(vendorIdentity.id);

      const channelId = encodeStreamIdentifier("vendor", `${rfpId}-${vendorIdentity.id}`);
      const channelCreatorId =
        viewer.type === "internal"
          ? viewer.user.id
          : teamIdentities[0]?.id || vendorIdentity.id;

      const channel = chat.channel("messaging", channelId, {
        name: `${rfp.title} • ${vendorIdentity.name}`,
        rfp_id: rfp.id,
        vendor_email: vendorEmail,
        created_by_id: channelCreatorId,
      });
      await ensureChannelWithMembers(channel, Array.from(memberIds));

      const token = chat.createToken(viewerIdentity.id);

      res.json({
        apiKey: streamEnv.key,
        appId: streamEnv.appId,
        token,
        user: viewerIdentity,
        channel: {
          id: channelId,
          type: "messaging",
          name: `${rfp.title} • ${vendorIdentity.name}`,
          data: {
            rfpId: rfp.id,
            vendorEmail,
            workspaceId: rfp.workspaceId,
          },
        },
        context: {
          type: "vendor",
          rfp: {
            id: rfp.id,
            title: rfp.title,
            companyName: rfp.companyName,
            status: rfp.status,
            deadline: rfp.deadline,
          },
          vendor: {
            name: vendorIdentity.name,
            email: vendorEmail,
            logoUrl: vendorIdentity.image,
            proposalCount: proposals.length,
            latestProposalId: latestProposal?.id,
          },
          team: teamIdentities,
        },
      });
    } catch (error) {
      console.error("Error loading vendor chat:", error);
      res.status(500).json({ message: "Failed to load chat" });
    }
  });

  // Team
  app.get("/api/team", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json([]);
      }
      const members = await storage.getUsersByWorkspace(user.workspaceId);
      res.json(members);
    } catch (error) {
      console.error("Error fetching team:", error);
      res.status(500).json({ message: "Failed to fetch team" });
    }
  });

  // Invites
  app.get("/api/invites", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId || !user.isAdmin) {
        return res.json([]);
      }
      const invites = await storage.getInvitesByWorkspace(user.workspaceId);
      res.json(invites);
    } catch (error) {
      console.error("Error fetching invites:", error);
      res.status(500).json({ message: "Failed to fetch invites" });
    }
  });

  app.post("/api/invites", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId || !user.isAdmin) {
        return res.status(403).json({ message: "Not authorized" });
      }

      const workspace = await storage.getWorkspace(user.workspaceId);
      if (!workspace) {
        return res.status(404).json({ message: "Workspace not found" });
      }

      const token = generateToken();
      const invite = await storage.createInvite({
        workspaceId: user.workspaceId,
        email: req.body.email,
        invitedById: userId,
        token,
        status: "pending",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 1 week
      });

      // Send invitation email
      const protocol = req.protocol;
      const host = req.get("host");
      const inviteLink = `${protocol}://${host}/invite/${token}`;
      const inviterName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || "A team member";
      
      try {
        await sendTeamInvitation(req.body.email, inviteLink, inviterName, workspace.name);
      } catch (emailError) {
        console.error("Failed to send invite email:", emailError);
      }

      res.json(invite);
    } catch (error) {
      console.error("Error creating invite:", error);
      res.status(500).json({ message: "Failed to create invite" });
    }
  });

  app.delete("/api/invites/:id", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.isAdmin) {
        return res.status(403).json({ message: "Not authorized" });
      }
      await storage.deleteInvite(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting invite:", error);
      res.status(500).json({ message: "Failed to delete invite" });
    }
  });

  // Vendors
  app.get("/api/vendors", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json([]);
      }
      const vendors = await storage.getVendorsByWorkspace(user.workspaceId);
      res.json(vendors);
    } catch (error) {
      console.error("Error fetching vendors:", error);
      res.status(500).json({ message: "Failed to fetch vendors" });
    }
  });

  app.post("/api/vendors", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.status(403).json({ message: "No workspace found" });
      }

      const payload = req.body || {};
      if (!payload.name) {
        return res.status(400).json({ message: "Vendor name is required" });
      }

      const vendor = await storage.createVendor({
        workspaceId: user.workspaceId,
        name: payload.name,
        email: payload.email,
        phone: payload.phone,
        website: payload.website,
        address: payload.address,
        taxId: payload.taxId,
        paymentTerms: payload.paymentTerms || "net_30",
        bankAccountInfo: payload.bankAccountInfo || null,
        isActive: payload.isActive ?? true,
        rating: typeof payload.rating === "number" ? payload.rating : null,
        notes: payload.notes,
        createdById: userId,
      });

      res.json(vendor);
    } catch (error) {
      console.error("Error creating vendor:", error);
      res.status(500).json({ message: "Failed to create vendor" });
    }
  });

  app.get("/api/vendors/:id", isAuthenticated, async (req: any, res) => {
    try {
      const vendor = await storage.getVendor(req.params.id);
      if (!vendor) {
        return res.status(404).json({ message: "Vendor not found" });
      }
      res.json(vendor);
    } catch (error) {
      console.error("Error fetching vendor:", error);
      res.status(500).json({ message: "Failed to fetch vendor" });
    }
  });

  app.get("/api/vendor/profile", isAuthenticated, async (req: any, res) => {
    try {
      const { vendorId, email } = req.query as { vendorId?: string; email?: string };
      if (!vendorId && !email) {
        return res.status(400).json({ message: "vendorId or email is required" });
      }

      const vendor = vendorId
        ? await storage.getVendor(vendorId)
        : email
        ? await storage.getVendorByEmail(email)
        : null;

      if (!vendor) {
        return res.status(404).json({ message: "Vendor not found" });
      }

      const ratings = await storage.getSupplierRatingsByVendor(vendor.id);
      res.json({ vendor, ratings });
    } catch (error) {
      console.error("Error loading vendor profile:", error);
      res.status(500).json({ message: "Failed to load vendor profile" });
    }
  });

  app.get("/api/vendor/invoice/context", async (req, res) => {
    try {
      const vendorId = typeof req.query.vendorId === "string" ? req.query.vendorId : "";
      const rfpId = typeof req.query.rfpId === "string" ? req.query.rfpId : "";
      if (!vendorId || !rfpId) {
        return res.status(400).json({ message: "vendorId and rfpId are required" });
      }

      const vendor = await storage.getVendor(vendorId);
      const rfp = await storage.getRfp(rfpId);
      if (!vendor || !rfp || vendor.workspaceId !== rfp.workspaceId) {
        return res.status(404).json({ message: "Unable to locate that vendor/RFP pairing" });
      }

      const workspace = vendor.workspaceId ? await storage.getWorkspace(vendor.workspaceId) : null;
      const buyerEmail = workspace?.billingEmail || null;
      const buyerName = workspace?.name || rfp.companyName || "Buyer";

      res.json({
        vendor: {
          id: vendor.id,
          name: vendor.name,
          email: vendor.email,
        },
        rfp: {
          id: rfp.id,
          title: rfp.title,
          companyName: rfp.companyName,
          companyLogo: rfp.companyLogo,
        },
        buyer: {
          name: buyerName,
          email: buyerEmail,
        },
      });
    } catch (error) {
      console.error("Error loading vendor invoice context:", error);
      res.status(500).json({ message: "Failed to load vendor invoice context" });
    }
  });

  app.post("/api/vendor/invoice/submit", async (req, res) => {
    try {
      const parsed = vendorInvoiceSubmissionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten().formErrors.join(", ") });
      }
      const data = parsed.data;
      const vendor = await storage.getVendor(data.vendorId);
      const rfp = await storage.getRfp(data.rfpId);
      if (!vendor || !rfp || vendor.workspaceId !== rfp.workspaceId) {
        return res.status(404).json({ message: "Unable to locate that vendor/RFP pairing" });
      }

      const normalizedContact = data.contactEmail.toLowerCase();
      if (vendor.email && vendor.email.toLowerCase() !== normalizedContact) {
        return res.status(403).json({
          message: "Please use the email address that was registered for this vendor.",
        });
      }

      const invoiceDate = parseDateInput(data.invoiceDate) ?? new Date();
      const dueDate = parseDateInput(data.dueDate) ?? null;
      const receiptImageUrl =
        data.fileDataUrl && data.fileDataUrl.startsWith("data:") ? data.fileDataUrl : null;

      const invoiceNumber = data.invoiceNumber?.trim() || generateInvoiceNumber(vendor.workspaceId);
      const invoice = await storage.createPurchaseInvoice({
        workspaceId: vendor.workspaceId,
        vendorId: vendor.id,
        poId: null,
        invoiceNumber,
        title: invoiceNumber,
        description: data.description,
        status: "submitted",
        totalAmount: toCents(data.amount),
        taxAmount: 0,
        currency: "USD",
        invoiceDate,
        dueDate,
        receiptImageUrl,
        approvedById: null,
        approvedAt: null,
        createdById: null,
        ocrData: {
          submittedVia: "vendor-portal",
          contactEmail: data.contactEmail,
          rfpId: data.rfpId,
          originalFileName: data.fileName,
        },
      });

      res.json({ invoiceId: invoice.id });
    } catch (error) {
      console.error("Vendor invoice submission failed:", error);
      res.status(500).json({ message: "Failed to submit invoice" });
    }
  });


  app.get("/api/payables/purchase-invoices", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json({
          invoices: [],
          vendors: [],
          stats: {
            totalInvoices: 0,
            outstandingAmount: 0,
            overdueCount: 0,
            dueSoonCount: 0,
            paidThisMonth: 0,
          },
        });
      }

      const [invoices, vendors] = await Promise.all([
        storage.getPurchaseInvoicesByWorkspace(user.workspaceId),
        storage.getVendorsByWorkspace(user.workspaceId),
      ]);

      const vendorById = new Map(vendors.map((vendor) => [vendor.id, vendor]));
      const enrichedInvoices = await Promise.all(
        invoices.map(async (invoice) => {
          const invoiceLineItems = await storage.getInvoiceLineItems(invoice.id);
          return {
            ...invoice,
            vendor: vendorById.get(invoice.vendorId) || null,
            lineItems: invoiceLineItems,
          };
        })
      );

      const outstanding = enrichedInvoices.filter(
        (invoice) => invoice.status !== "paid" && invoice.status !== "cancelled"
      );
      const now = new Date();
      const overdueCount = enrichedInvoices.filter((invoice) => {
        if (!invoice.dueDate || invoice.status === "paid") return false;
        return new Date(invoice.dueDate) < now;
      }).length;
      const dueSoonCount = enrichedInvoices.filter((invoice) => {
        if (!invoice.dueDate || invoice.status === "paid") return false;
        const due = new Date(invoice.dueDate).getTime();
        const diff = due - now.getTime();
        return diff > 0 && diff <= FOURTEEN_DAYS_MS;
      }).length;
      const paidThisMonth = enrichedInvoices
        .filter((invoice) => invoice.status === "paid" && invoice.paidDate)
        .filter((invoice) => {
          const paidDate = new Date(invoice.paidDate!);
          return (
            paidDate.getMonth() === now.getMonth() && paidDate.getFullYear() === now.getFullYear()
          );
        })
        .reduce((sum, invoice) => sum + invoice.totalAmount, 0);

      res.json({
        invoices: enrichedInvoices,
        vendors,
        stats: {
          totalInvoices: invoices.length,
          outstandingAmount: outstanding.reduce((sum, invoice) => sum + invoice.totalAmount, 0),
          overdueCount,
          dueSoonCount,
          paidThisMonth,
        },
      });
    } catch (error) {
      console.error("Error fetching purchase invoices:", error);
      res.status(500).json({ message: "Failed to fetch purchase invoices" });
    }
  });

  app.post("/api/invoices/add", isAuthenticated, async (req: any, res) => {
    try {
      const parseResult = purchaseInvoiceInputSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ message: parseResult.error.flatten().formErrors.join(", ") });
      }

      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.status(403).json({ message: "Workspace not found" });
      }

      const data = parseResult.data;
      const invoiceRecord = {
        workspaceId: user.workspaceId,
        vendorId: data.vendorId,
        poId: data.poId || null,
        invoiceNumber: data.invoiceNumber || generateInvoiceNumber(user.workspaceId),
        title: data.title || data.invoiceNumber || "Purchase invoice",
        description: data.description,
        status: data.status || "pending",
        totalAmount: toCents(data.totalAmount),
        taxAmount: toCents(data.taxAmount ?? 0),
        currency: (data.currency || "USD").toUpperCase(),
        invoiceDate: new Date(data.invoiceDate),
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        ocrData: data.ocrData,
        receiptImageUrl: data.receiptImageUrl,
        createdById: userId,
      };

      const invoice = await storage.createPurchaseInvoice(invoiceRecord);
      const createdLineItems = [];
      if (data.lineItems?.length) {
        for (const item of data.lineItems) {
          const newItem = await storage.createInvoiceLineItem({
            invoiceId: invoice.id,
            description: item.description,
            quantity: item.quantity,
            unitPrice: toCents(item.unitPrice),
            totalPrice: toCents(item.totalPrice ?? item.unitPrice * item.quantity),
            category: item.category,
          });
          createdLineItems.push(newItem);
        }
      }

      const vendor = await storage.getVendor(invoice.vendorId);
      res.json({ invoice: { ...invoice, vendor }, lineItems: createdLineItems });
    } catch (error) {
      console.error("Error creating purchase invoice:", error);
      res.status(500).json({ message: "Failed to create purchase invoice" });
    }
  });

  app.get("/api/rfps", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json([]);
      }
      const rfps = await storage.getRfpsByWorkspace(user.workspaceId);
      res.json(rfps);
    } catch (error) {
      console.error("Error fetching RFPs:", error);
      res.status(500).json({ message: "Failed to fetch RFPs" });
    }
  });

  app.get("/api/rfps/:id", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      const rfp = await storage.getRfp(req.params.id);
      if (!user?.workspaceId || !rfp || rfp.workspaceId !== user.workspaceId) {
        return res.status(404).json({ message: "RFP not found" });
      }
      res.json(rfp);
    } catch (error) {
      console.error("Error fetching RFP:", error);
      res.status(500).json({ message: "Failed to fetch RFP" });
    }
  });

  app.get("/api/rfp/chat/:id", async (req: any, res) => {
    try {
      const rfpId = req.params.id;
      const requestedEmail = typeof req.query.email === "string" ? req.query.email.toLowerCase() : undefined;
      const rfp = await storage.getRfp(rfpId);
      if (!rfp) {
        return res.status(404).json({ message: "RFP not found" });
      }

      const viewer = await resolveRfpChatViewer(req, rfp);
      if (viewer.type === "anonymous") {
        return res.status(401).json({ message: "Unauthorized" });
      }

      if (viewer.type === "vendor" && requestedEmail && requestedEmail !== viewer.email) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const targetEmail = viewer.type === "vendor" ? viewer.email : requestedEmail;
      let vendorRecord =
        targetEmail ? await storage.getVendorByEmail(targetEmail) : null;
      if (vendorRecord && vendorRecord.workspaceId !== rfp.workspaceId) {
        vendorRecord = null;
      }

      const proposals = targetEmail
        ? await storage.getProposalsByRfpAndEmail(rfpId, targetEmail)
        : await storage.getProposalsByRfp(rfpId);

      if (viewer.type === "vendor" && proposals.length === 0) {
        return res.status(403).json({ message: "No proposal found for this email" });
      }

      const teamMembersRaw = await storage.getUsersByWorkspace(rfp.workspaceId);
      const teamMembers = teamMembersRaw.map((member) => ({
        id: member.id,
        firstName: member.firstName,
        lastName: member.lastName,
        email: member.email,
        profileImageUrl: member.profileImageUrl,
        role: member.role,
      }));

      const proposalIdsForViewer =
        targetEmail ? proposals.map((proposal) => proposal.id).filter(Boolean) : null;

      const communications = await storage.getVendorCommunications({
        workspaceId: rfp.workspaceId,
        rfpId,
        vendorId: vendorRecord?.id || undefined,
        proposalIds: !vendorRecord && proposalIdsForViewer && proposalIdsForViewer.length ? proposalIdsForViewer : undefined,
      });

      const serializedCommunications = communications.map((communication) => ({
        ...communication,
        createdAt: communication.createdAt ? new Date(communication.createdAt).toISOString() : communication.createdAt,
        updatedAt: communication.updatedAt ? new Date(communication.updatedAt).toISOString() : communication.updatedAt,
      }));

      const normalizedProposals = proposals.map((proposal) => ({
        id: proposal.id,
        company: proposal.company,
        status: proposal.status,
        submittedAt: proposal.submittedAt ? new Date(proposal.submittedAt).toISOString() : proposal.submittedAt,
      }));

      const verifiedUser =
        viewer.type === "vendor"
          ? {
              email: viewer.email,
              proposals: proposals.map((proposal) => ({
                id: proposal.id,
                company: proposal.company,
                firstName: proposal.firstName,
                lastName: proposal.lastName,
              })),
            }
          : viewer.type === "internal"
          ? {
              email: viewer.user.email,
              proposals: proposals.map((proposal) => ({
                id: proposal.id,
                company: proposal.company,
                firstName: proposal.firstName,
                lastName: proposal.lastName,
              })),
            }
          : undefined;

      res.json({
        rfp,
        proposals: normalizedProposals,
        verifiedUser,
        teamMembers,
        comments: [],
        communications: serializedCommunications,
        canModerate: viewer.type === "internal",
      });
    } catch (error) {
      console.error("Error fetching RFP chat:", error);
      res.status(500).json({ message: "Failed to fetch chat" });
    }
  });

  app.post("/api/rfp/chat/:id/message", async (req: any, res) => {
    try {
      const rfpId = req.params.id;
      const { content, parentId } = req.body || {};
      if (!content || typeof content !== "string" || !content.trim()) {
        return res.status(400).json({ message: "Content is required" });
      }

      const rfp = await storage.getRfp(rfpId);
      if (!rfp) {
        return res.status(404).json({ message: "RFP not found" });
      }

      const viewer = await resolveRfpChatViewer(req, rfp);
      if (viewer.type === "anonymous") {
        return res.status(401).json({ message: "Unauthorized" });
      }

      let authorId: string | null = null;
      let authorName = "Guest";
      let authorEmail: string | null = null;
      let direction: "outbound" | "inbound" = "outbound";
      let isVendorMessage = false;
      let proposalId: string | null = null;
      let vendorId: string | null = null;

      if (viewer.type === "vendor") {
        direction = "inbound";
        isVendorMessage = true;
        authorEmail = viewer.email;
        authorName = viewer.email.split("@")[0] || viewer.email;
        const vendorProposals = await storage.getProposalsByRfpAndEmail(rfpId, viewer.email);
        if (vendorProposals.length === 0) {
          return res.status(403).json({ message: "No proposal found for this email" });
        }
        proposalId = vendorProposals[0].id;
        const vendorRecord = await storage.getVendorByEmail(viewer.email);
        vendorId = vendorRecord && vendorRecord.workspaceId === rfp.workspaceId ? vendorRecord.id : null;
      } else if (viewer.type === "internal") {
        direction = "outbound";
        isVendorMessage = false;
        authorId = viewer.user.id;
        authorEmail = viewer.user.email;
        authorName =
          `${viewer.user.firstName || ""} ${viewer.user.lastName || ""}`.trim() ||
          viewer.user.email ||
          "Workspace user";
      }

      const communication = await storage.createVendorCommunication({
        vendorId,
        rfpId: rfp.id,
        proposalId,
        workspaceId: rfp.workspaceId,
        content: content.trim(),
        authorId,
        authorName,
        authorEmail,
        channel: "chat",
        direction,
        isVendorMessage,
        parentCommunicationId: parentId || null,
      });

      await triggerChannelEvent(`presence-rfp-chat-${rfp.id}`, "new-message", communication);
      res.json(communication);
    } catch (error) {
      console.error("Error sending RFP chat message:", error);
      res.status(500).json({ message: "Failed to send message" });
    }
  });

  app.delete("/api/rfp/chat/:rfpId/message/:messageId", async (req: any, res) => {
    try {
      const { rfpId, messageId } = req.params;
      const rfp = await storage.getRfp(rfpId);
      if (!rfp) {
        return res.status(404).json({ message: "RFP not found" });
      }

      const viewer = await resolveRfpChatViewer(req, rfp);
      if (viewer.type !== "internal") {
        return res.status(403).json({ message: "Not authorized" });
      }

      const message = await storage.getVendorCommunication(messageId);
      if (!message || message.rfpId !== rfpId) {
        return res.status(404).json({ message: "Message not found" });
      }

      await storage.deleteVendorCommunication(messageId);
      res.json({ deletedIds: [messageId] });
    } catch (error) {
      console.error("Error deleting RFP chat message:", error);
      res.status(500).json({ message: "Failed to delete message" });
    }
  });

  app.post("/api/rfp/chat/:id/typing", async (req: any, res) => {
    try {
      const rfpId = req.params.id;
      const rfp = await storage.getRfp(rfpId);
      if (!rfp) {
        return res.status(404).json({ message: "RFP not found" });
      }

      const viewer = await resolveRfpChatViewer(req, rfp);
      if (viewer.type === "anonymous") {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const providedName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const displayName =
        providedName ||
        (viewer.type === "vendor"
          ? viewer.email.split("@")[0] || viewer.email
          : `${viewer.user.firstName || ""} ${viewer.user.lastName || ""}`.trim() ||
            viewer.user.email ||
            "Workspace user");

      await triggerChannelEvent(`presence-rfp-chat-${rfpId}`, "typing", { name: displayName });
      res.status(204).end();
    } catch (error) {
      console.error("Error broadcasting RFP typing event:", error);
      res.status(500).json({ message: "Failed to broadcast typing event" });
    }
  });

  app.post("/api/rfp/magic-link", async (req: any, res) => {
    try {
      const { email, rfpId } = req.body || {};
      if (!email || !rfpId) {
        return res.status(400).json({ message: "Email and rfpId are required" });
      }

      const rfp = await storage.getRfp(rfpId);
      if (!rfp) {
        return res.status(404).json({ message: "RFP not found" });
      }

      const token = createRfpMagicLinkToken(rfpId, email);
      const protocol = req.protocol;
      const host = req.get("host");
      const chatLink = `${protocol}://${host}/chat/vendor?id=${rfpId}&email=${encodeURIComponent(email)}&token=${token}`;

      await sendChatInvitation(email, chatLink, token, rfp.title);

      res.json({ success: true });
    } catch (error) {
      console.error("Error sending RFP magic link:", error);
      res.status(500).json({ message: "Failed to send magic link" });
    }
  });

  app.get("/api/proposals", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json([]);
      }
      const proposals = await storage.getProposalsByWorkspace(user.workspaceId);
      res.json(proposals);
    } catch (error) {
      console.error("Error fetching proposals:", error);
      res.status(500).json({ message: "Failed to fetch proposals" });
    }
  });

  app.post("/api/proposals", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.status(403).json({ message: "No workspace found" });
      }

      const payload = req.body || {};
      if (!payload.rfpId) {
        return res.status(400).json({ message: "rfpId is required" });
      }

      const rfp = await storage.getRfp(payload.rfpId);
      if (!rfp || rfp.workspaceId !== user.workspaceId) {
        return res.status(404).json({ message: "RFP not found" });
      }

      const requiredFields = ["firstName", "lastName", "email", "company", "teamSize", "hourlyRate"];
      if (requiredFields.some((field) => !payload[field])) {
        return res.status(400).json({ message: "Missing required proposal fields" });
      }

      const parseCurrency = (value: any) => {
        if (value === undefined || value === null || value === "") return 0;
        const numeric = typeof value === "string" ? parseFloat(value.replace(/[^0-9.]/g, "")) : Number(value);
        return Number.isNaN(numeric) ? 0 : Math.round(numeric * 100);
      };

      const proposal = await storage.createProposal({
        rfpId: rfp.id,
        firstName: payload.firstName,
        lastName: payload.lastName,
        email: payload.email,
        company: payload.company,
        vendorLogoUrl: payload.vendorLogoUrl || null,
        website: payload.website || null,
        teamSize: payload.teamSize,
        certifications: Array.isArray(payload.certifications)
          ? payload.certifications
          : typeof payload.certifications === "string" && payload.certifications.length
          ? payload.certifications.split(",").map((item: string) => item.trim()).filter(Boolean)
          : [],
        hourlyRate: parseCurrency(payload.hourlyRate),
        capabilitiesStatementUrl: payload.capabilitiesStatementUrl || null,
        coverLetter: payload.coverLetter || null,
        technicalApproach: payload.technicalApproach || null,
        timeline: payload.timeline || null,
        budget: parseCurrency(payload.budget),
        status: payload.status || "submitted",
      });

      res.json(proposal);
    } catch (error) {
      console.error("Error creating proposal:", error);
      res.status(500).json({ message: "Failed to submit proposal" });
    }
  });

  app.get("/api/proposals/:id", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.status(404).json({ message: "Proposal not found" });
      }
      const proposal = await storage.getProposalWithRfp(req.params.id);
      if (!proposal || proposal.rfp.workspaceId !== user.workspaceId) {
        return res.status(404).json({ message: "Proposal not found" });
      }
      res.json(proposal);
    } catch (error) {
      console.error("Error fetching proposal:", error);
      res.status(500).json({ message: "Failed to fetch proposal" });
    }
  });

  app.get("/api/vendor-communications", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json([]);
      }

      const { vendorId, rfpId, email } = req.query as { vendorId?: string; rfpId?: string; email?: string };
      const communications = await storage.getVendorCommunications({
        workspaceId: user.workspaceId,
        vendorId,
        rfpId,
        email,
      });
      res.json(communications);
    } catch (error) {
      console.error("Error fetching vendor communications:", error);
      res.status(500).json({ message: "Failed to fetch communications" });
    }
  });

  app.post("/api/vendor-communications/typing", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.status(403).json({ message: "No workspace found" });
      }

      const { vendorId, rfpId, name } = req.body || {};
      if (!vendorId || !rfpId) {
        return res.status(400).json({ message: "vendorId and rfpId are required" });
      }

      const vendor = await storage.getVendor(vendorId);
      if (!vendor || vendor.workspaceId !== user.workspaceId) {
        return res.status(404).json({ message: "Vendor not found" });
      }

      const rfp = await storage.getRfp(rfpId);
      if (!rfp || rfp.workspaceId !== user.workspaceId) {
        return res.status(404).json({ message: "RFP not found" });
      }

      const displayName =
        (typeof name === "string" && name.trim()) ||
        `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
        user.email ||
        "Workspace user";

      await triggerChannelEvent(
        `presence-vendor-chat-${vendorId}-${rfpId}`,
        "typing",
        { name: displayName }
      );

      res.status(204).end();
    } catch (error) {
      console.error("Error broadcasting vendor typing event:", error);
      res.status(500).json({ message: "Failed to broadcast typing event" });
    }
  });

  app.post("/api/vendor-communications", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.status(403).json({ message: "No workspace found" });
      }

      const { vendorId, rfpId, proposalId, content } = req.body || {};
      if (!content || typeof content !== "string" || !content.trim()) {
        return res.status(400).json({ message: "Content is required" });
      }

      let vendor = null;
      if (vendorId) {
        vendor = await storage.getVendor(vendorId);
        if (!vendor || vendor.workspaceId !== user.workspaceId) {
          return res.status(404).json({ message: "Vendor not found" });
        }
      }

      let rfp = null;
      if (rfpId) {
        rfp = await storage.getRfp(rfpId);
        if (!rfp || rfp.workspaceId !== user.workspaceId) {
          return res.status(404).json({ message: "RFP not found" });
        }
      }

      const authorName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "Workspace user";

      const communication = await storage.createVendorCommunication({
        vendorId: vendor?.id || null,
        rfpId: rfp?.id || null,
        proposalId: proposalId || null,
        workspaceId: user.workspaceId,
        content: content.trim(),
        authorId: userId,
        authorName,
        authorEmail: user.email,
        channel: "chat",
        direction: "outbound",
        isVendorMessage: false,
      });

      if (communication.vendorId && communication.rfpId) {
        await triggerChannelEvent(
          `presence-vendor-chat-${communication.vendorId}-${communication.rfpId}`,
          "new-message",
          communication
        );
      }

      if (communication.rfpId) {
        await triggerChannelEvent(
          `presence-rfp-chat-${communication.rfpId}`,
          "new-message",
          communication
        );
      }

      res.json(communication);
    } catch (error) {
      console.error("Error creating vendor communication:", error);
      res.status(500).json({ message: "Failed to send communication" });
    }
  });

  // Workspace
  app.get("/api/workspace", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.status(404).json({ message: "No workspace" });
      }
      const workspace = await storage.getWorkspace(user.workspaceId);
      res.json(workspace);
    } catch (error) {
      console.error("Error fetching workspace:", error);
      res.status(500).json({ message: "Failed to fetch workspace" });
    }
  });

  app.patch("/api/workspace", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId || !user.isAdmin) {
        return res.status(403).json({ message: "Not authorized" });
      }
      const workspace = await storage.updateWorkspace(user.workspaceId, req.body);
      res.json(workspace);
    } catch (error) {
      console.error("Error updating workspace:", error);
      res.status(500).json({ message: "Failed to update workspace" });
    }
  });

  // User profile
  app.patch("/api/users/me", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.updateUser(userId, req.body);
      res.json(user);
    } catch (error) {
      console.error("Error updating user:", error);
      res.status(500).json({ message: "Failed to update user" });
    }
  });

  // Stripe checkout
  app.post("/api/create-checkout-session", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      const protocol = req.protocol;
      const host = req.get("host");
      const successUrl = `${protocol}://${host}/?success=true`;
      const cancelUrl = `${protocol}://${host}/trial-expired`;

      console.log("Creating checkout session for user:", userId, user.email);
      console.log("Stripe key loaded:", !!process.env.STRIPE_SECRET_KEY);

      const session = await stripe.checkout.sessions.create({
        line_items: [{
          price: 'price_1SYv6HFRJliLrxglmBv4BkA5',
        }],
        mode: 'subscription',
        metadata: {
          userId: userId,
          workspaceId: user.workspaceId || '',
          userEmail: user.email!,
        },
        success_url: successUrl,
        cancel_url: cancelUrl,
        allow_promotion_codes: true,
      });

      console.log("Checkout session created:", session.id);
      res.json({ url: session.url });
    } catch (error) {
      console.error("Error creating checkout session:", error);
      res.status(500).json({ message: "Failed to create checkout session", error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Stripe webhook
  app.post("/api/webhooks/stripe", async (req, res) => {
    const sig = req.headers['stripe-signature'] as string;
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret!);
    } catch (err) {
      console.log(`Webhook signature verification failed.`, err);
      return res.status(400).send('Webhook Error');
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as any;
          console.log('Checkout session completed:', session.id);

          if (session.metadata?.userId && session.metadata?.workspaceId) {
            const userId = session.metadata.userId;
            const workspaceId = session.metadata.workspaceId;

            // Update workspace to active
            await storage.updateWorkspace(workspaceId, { subscriptionStatus: 'active' });

            // Create workspace subscription record
            if (session.subscription) {
              const subscription = await stripe.subscriptions.retrieve(session.subscription) as any;
              await storage.createWorkspaceSubscription({
                workspaceId,
                stripeCustomerId: session.customer,
                stripeSubscriptionId: session.subscription,
                status: subscription.status,
                trialEndDate: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
                currentPeriodStart: new Date(subscription.current_period_start * 1000),
                currentPeriodEnd: new Date(subscription.current_period_end * 1000),
              });
            }

            console.log(`Activated subscription for workspace ${workspaceId}, user ${userId}`);
          }
          break;
        }

        case 'invoice.payment_succeeded': {
          const invoice = event.data.object as any;
          console.log('Invoice payment succeeded:', invoice.id);

          // Update subscription status if needed
          if (invoice.subscription) {
            const subscription = await stripe.subscriptions.retrieve(invoice.subscription) as any;
            // Update workspace subscription status
            await storage.updateWorkspaceSubscription(invoice.subscription, {
              status: subscription.status,
              currentPeriodStart: new Date(subscription.current_period_start * 1000),
              currentPeriodEnd: new Date(subscription.current_period_end * 1000),
            });
          }
          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object as any;
          console.log('Subscription cancelled:', subscription.id);

          // Update workspace back to trial or inactive
          await storage.updateWorkspaceSubscription(subscription.id, {
            status: 'canceled',
          });

          // Optionally update workspace status
          // await storage.updateWorkspace(workspaceId, { subscriptionStatus: 'canceled' });
          break;
        }

        case 'payment_intent.succeeded': {
          const paymentIntent = event.data.object as any;
          console.log('Payment succeeded:', paymentIntent.id);

          // Handle Stripe Connect payments
          if (paymentIntent.metadata?.invoiceId && paymentIntent.metadata?.workspaceId) {
            const invoiceId = paymentIntent.metadata.invoiceId;
            const workspaceId = paymentIntent.metadata.workspaceId;

            try {
              // Update invoice status to paid
              await storage.updateSalesInvoice(invoiceId, {
                status: 'paid',
                paidDate: new Date(),
              });

              // Create customer payment record
              const invoice = await storage.getSalesInvoice(invoiceId);
              if (invoice) {
                await storage.createCustomerPayment({
                  workspaceId,
                  customerId: invoice.customerId,
                  invoiceId: invoiceId,
                  amount: paymentIntent.amount_received,
                  currency: paymentIntent.currency.toUpperCase(),
                  method: 'credit_card',
                  paymentDate: new Date(),
                  externalTransactionId: paymentIntent.id,
                  createdById: null,
                });
              }

              console.log(`Successfully processed payment for invoice ${invoiceId}, workspace ${workspaceId}`);
            } catch (paymentError) {
              console.error('Error processing Stripe Connect payment:', paymentError);
            }
          }
          break;
        }

        // Stripe Connect Account Webhook Events
        case 'account.updated': {
          const account = event.data.object as any;
          console.log('Stripe Connect account updated:', account.id);

          // Find workspace by Stripe Connect account ID
          const workspaces = await storage.getWorkspacesByStripeConnectAccountId(account.id);
          if (workspaces.length > 0) {
            const workspace = workspaces[0];

            // Update workspace with current account status
            await storage.updateWorkspace(workspace.id, {
              stripeConnectEnabled: account.details_submitted,
              stripeConnectChargesEnabled: account.charges_enabled,
              stripeConnectPayoutsEnabled: account.payouts_enabled,
              // Only mark onboarding complete when both charges AND payouts are enabled
              stripeConnectOnboardingComplete: account.charges_enabled && account.payouts_enabled,
              stripeConnectOnboardingStarted: true,
              stripeConnectOnboardingStatus: (account.charges_enabled && account.payouts_enabled) ? 'complete' : 'in_progress',
              stripeConnectBusinessProfile: account.business_profile,
              stripeConnectLastWebhookEvent: 'account.updated',
              stripeConnectLastWebhookTimestamp: new Date(),
            });

            // Track the onboarding event
            const currentEvents = Array.isArray(workspace.stripeConnectOnboardingEvents) ? workspace.stripeConnectOnboardingEvents : [];
            await storage.updateWorkspace(workspace.id, {
              stripeConnectOnboardingEvents: [...currentEvents, {
                event: 'account.updated',
                timestamp: new Date().toISOString(),
                data: {
                  details_submitted: account.details_submitted,
                  charges_enabled: account.charges_enabled,
                  payouts_enabled: account.payouts_enabled,
                }
              }]
            });

            console.log(`Updated Stripe Connect status for workspace ${workspace.id}`);
          }
          break;
        }

        case 'account.application.authorized': {
          const account = event.data.object as any;
          console.log('Stripe Connect account authorized:', account.id);

          // Find workspace by Stripe Connect account ID
          const workspaces = await storage.getWorkspacesByStripeConnectAccountId(account.id);
          if (workspaces.length > 0) {
            const workspace = workspaces[0];

            // Update workspace with authorization status
            await storage.updateWorkspace(workspace.id, {
              stripeConnectEnabled: true,
              stripeConnectOnboardingStarted: true,
              stripeConnectOnboardingStatus: 'authorized',
              stripeConnectLastWebhookEvent: 'account.application.authorized',
              stripeConnectLastWebhookTimestamp: new Date(),
            });

            // Track the authorization event
            const currentEvents = Array.isArray(workspace.stripeConnectOnboardingEvents) ? workspace.stripeConnectOnboardingEvents : [];
            await storage.updateWorkspace(workspace.id, {
              stripeConnectOnboardingEvents: [...currentEvents, {
                event: 'account.application.authorized',
                timestamp: new Date().toISOString(),
                data: {
                  account_id: account.id,
                  authorized: true,
                }
              }]
            });

            console.log(`Stripe Connect account authorized for workspace ${workspace.id}`);
          }
          break;
        }

        case 'account.application.deauthorized': {
          const account = event.data.object as any;
          console.log('Stripe Connect account deauthorized:', account.id);

          // Find workspace by Stripe Connect account ID
          const workspaces = await storage.getWorkspacesByStripeConnectAccountId(account.id);
          if (workspaces.length > 0) {
            const workspace = workspaces[0];

            // Update workspace with deauthorization status
            await storage.updateWorkspace(workspace.id, {
              stripeConnectEnabled: false,
              stripeConnectOnboardingStatus: 'deauthorized',
              stripeConnectLastWebhookEvent: 'account.application.deauthorized',
              stripeConnectLastWebhookTimestamp: new Date(),
            });

            // Track the deauthorization event
            const currentEvents = Array.isArray(workspace.stripeConnectOnboardingEvents) ? workspace.stripeConnectOnboardingEvents : [];
            await storage.updateWorkspace(workspace.id, {
              stripeConnectOnboardingEvents: [...currentEvents, {
                event: 'account.application.deauthorized',
                timestamp: new Date().toISOString(),
                data: {
                  account_id: account.id,
                  authorized: false,
                }
              }]
            });

            console.log(`Stripe Connect account deauthorized for workspace ${workspace.id}`);
          }
          break;
        }

        case 'identity.verification_session.verified': {
          const session = event.data.object as any;
          console.log('Identity verification session verified:', session.id);

          // Find workspace by Stripe Connect account ID
          const workspaces = await storage.getWorkspacesByStripeConnectAccountId(session.account_id);
          if (workspaces.length > 0) {
            const workspace = workspaces[0];

            // Track the verification event
            const currentEvents = Array.isArray(workspace.stripeConnectOnboardingEvents) ? workspace.stripeConnectOnboardingEvents : [];
            await storage.updateWorkspace(workspace.id, {
              stripeConnectOnboardingEvents: [...currentEvents, {
                event: 'identity.verification_session.verified',
                timestamp: new Date().toISOString(),
                data: {
                  verification_session_id: session.id,
                  status: session.status,
                }
              }],
              stripeConnectLastWebhookEvent: 'identity.verification_session.verified',
              stripeConnectLastWebhookTimestamp: new Date(),
            });

            console.log(`Identity verification completed for workspace ${workspace.id}`);
          }
          break;
        }

        case 'identity.verification_session.requires_input': {
          const session = event.data.object as any;
          console.log('Identity verification requires input:', session.id);

          // Find workspace by Stripe Connect account ID
          const workspaces = await storage.getWorkspacesByStripeConnectAccountId(session.account_id);
          if (workspaces.length > 0) {
            const workspace = workspaces[0];

            // Track the verification event
            const currentEvents = Array.isArray(workspace.stripeConnectOnboardingEvents) ? workspace.stripeConnectOnboardingEvents : [];
            await storage.updateWorkspace(workspace.id, {
              stripeConnectOnboardingEvents: [...currentEvents, {
                event: 'identity.verification_session.requires_input',
                timestamp: new Date().toISOString(),
                data: {
                  verification_session_id: session.id,
                  required_input: session.requirements?.currently_due || [],
                }
              }],
              stripeConnectLastWebhookEvent: 'identity.verification_session.requires_input',
              stripeConnectLastWebhookTimestamp: new Date(),
            });

            console.log(`Identity verification requires input for workspace ${workspace.id}`);
          }
          break;
        }

        case 'identity.verification_session.canceled': {
          const session = event.data.object as any;
          console.log('Identity verification session canceled:', session.id);

          // Find workspace by Stripe Connect account ID
          const workspaces = await storage.getWorkspacesByStripeConnectAccountId(session.account_id);
          if (workspaces.length > 0) {
            const workspace = workspaces[0];

            // Track the verification event
            const currentEvents = Array.isArray(workspace.stripeConnectOnboardingEvents) ? workspace.stripeConnectOnboardingEvents : [];
            await storage.updateWorkspace(workspace.id, {
              stripeConnectOnboardingEvents: [...currentEvents, {
                event: 'identity.verification_session.canceled',
                timestamp: new Date().toISOString(),
                data: {
                  verification_session_id: session.id,
                  reason: session.cancelation_reason,
                }
              }],
              stripeConnectLastWebhookEvent: 'identity.verification_session.canceled',
              stripeConnectLastWebhookTimestamp: new Date(),
            });

            console.log(`Identity verification canceled for workspace ${workspace.id}`);
          }
          break;
        }

        default:
          console.log(`Unhandled event type ${event.type}`);
      }

      res.json({ received: true });
    } catch (error) {
      console.error('Error processing webhook:', error);
      res.status(500).json({ error: 'Webhook handler failed' });
    }
  });

  // API Key management
  app.post("/api/users/generate-api-key", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const apiKey = generateToken(32); // Generate a new API key
      const user = await storage.updateUser(userId, { apiKey });
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      res.json({ apiKey: user.apiKey });
    } catch (error) {
      console.error("Error generating API key:", error);
      res.status(500).json({ message: "Failed to generate API key" });
    }
  });

  app.delete("/api/users/api-key", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      await storage.updateUser(userId, { apiKey: null });
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting API key:", error);
      res.status(500).json({ message: "Failed to delete API key" });
    }
  });

  // Update client logo (for public chat)
  app.patch("/api/chat/:slug/client-logo", async (req: any, res) => {
    try {
      const { slug } = req.params;
      const { clientName, clientLogoUrl } = req.body;

      if (!clientName || !clientLogoUrl) {
        return res.status(400).json({ message: "Client name and logo URL required" });
      }

      // Find the issue by slug and get its workspace
      const issue = await storage.getIssueBySlug(slug);
      if (!issue) {
        return res.status(404).json({ message: "Chat not found" });
      }

      // Store client logo URL in session/cookie for this chat
      // In a real app, you might want to store this somewhere more persistent
      res.json({ success: true, clientLogoUrl });
    } catch (error) {
      console.error("Error updating client logo:", error);
      res.status(500).json({ message: "Failed to update client logo" });
    }
  });

  // ==================== STRIPE CONNECT ====================

  // Create Stripe Connect Account
  app.post("/api/stripe/connect/create-account", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId || !user.isAdmin) {
        return res.status(403).json({ message: "Not authorized" });
      }

      const workspace = await storage.getWorkspace(user.workspaceId);
      if (!workspace) {
        return res.status(404).json({ message: "Workspace not found" });
      }

      // If already has a connected account, just return the onboarding URL
      if (workspace.stripeConnectAccountId) {
        const accountLink = await stripe.accountLinks.create({
          account: workspace.stripeConnectAccountId,
          refresh_url: `${process.env.APP_URL}/settings?stripe_connect=refresh`,
          return_url: `${process.env.APP_URL}/settings?stripe_connect=success`,
          type: 'account_onboarding',
        });

        return res.json({ 
          onboardingUrl: accountLink.url,
          accountId: workspace.stripeConnectAccountId
        });
      }

      // Create new connected account
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'US',
        email: workspace.billingEmail || user.email || undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: {
          name: workspace.name,
          product_description: 'Business services and consulting',
        },
        metadata: {
          workspaceId: workspace.id,
        },
      });

      // Update workspace with connected account info
      await storage.updateWorkspace(workspace.id, {
        stripeConnectAccountId: account.id,
        stripeConnectEnabled: true,
        stripeConnectOnboardingStarted: true,
        stripeConnectOnboardingStatus: 'in_progress',
        stripeConnectOnboardingEvents: [{
          event: 'account.created',
          timestamp: new Date().toISOString(),
          data: {
            account_id: account.id,
            capabilities_requested: ['card_payments', 'transfers']
          }
        }],
        stripeConnectLastWebhookEvent: 'account.created',
        stripeConnectLastWebhookTimestamp: new Date(),
      });

      // Create account link for onboarding
      const accountLink = await stripe.accountLinks.create({
        account: account.id,
        refresh_url: `${process.env.APP_URL}/settings?stripe_connect=refresh`,
        return_url: `${process.env.APP_URL}/settings?stripe_connect=success`,
        type: 'account_onboarding',
      });

      res.json({ 
        onboardingUrl: accountLink.url,
        accountId: account.id
      });
    } catch (error) {
      console.error("Error creating Stripe Connect account:", error);
      res.status(500).json({ message: "Failed to create Stripe Connect account", error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Refresh Stripe Connect Account Status
  app.post("/api/stripe/connect/refresh-status", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId || !user.isAdmin) {
        return res.status(403).json({ message: "Not authorized" });
      }

      const workspace = await storage.getWorkspace(user.workspaceId);
      if (!workspace?.stripeConnectAccountId) {
        return res.status(404).json({ message: "No Stripe Connect account found" });
      }

      // Retrieve account details from Stripe
      const account = await stripe.accounts.retrieve(workspace.stripeConnectAccountId);

      // Update workspace with current status
      await storage.updateWorkspace(workspace.id, {
        stripeConnectEnabled: account.details_submitted,
        stripeConnectChargesEnabled: account.charges_enabled,
        stripeConnectPayoutsEnabled: account.payouts_enabled,
        // Only mark onboarding complete when both charges AND payouts are enabled
        stripeConnectOnboardingComplete: account.charges_enabled && account.payouts_enabled,
        stripeConnectBusinessProfile: account.business_profile,
      });

      res.json({ 
        success: true,
        account: {
          id: account.id,
          charges_enabled: account.charges_enabled,
          payouts_enabled: account.payouts_enabled,
          details_submitted: account.details_submitted,
        }
      });
    } catch (error) {
      console.error("Error refreshing Stripe Connect status:", error);
      res.status(500).json({ message: "Failed to refresh Stripe Connect status", error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Create Payment Session for Invoice
  app.post("/api/stripe/connect/create-payment-session", isAuthenticated, async (req: any, res) => {
    try {
      const { invoiceId } = req.body;
      
      if (!invoiceId) {
        return res.status(400).json({ message: "Invoice ID is required" });
      }

      const invoice = await storage.getSalesInvoiceWithDetails(invoiceId);
      if (!invoice) {
        return res.status(404).json({ message: "Invoice not found" });
      }

      const workspace = await storage.getWorkspace(invoice.workspaceId);
      if (!workspace?.stripeConnectAccountId || !workspace.stripeConnectEnabled) {
        return res.status(400).json({ message: "Workspace does not have Stripe Connect enabled" });
      }

      // Create payment session
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: invoice.customer?.email || undefined,
        line_items: [
          {
            price_data: {
              currency: invoice.currency.toLowerCase(),
              product_data: {
                name: invoice.title,
                description: invoice.description || undefined,
              },
              unit_amount: invoice.totalAmount,
            },
            quantity: 1,
          },
        ],
        payment_intent_data: {
          application_fee_amount: Math.round(invoice.totalAmount * 0.04), // 4% application fee
          transfer_data: {
            destination: workspace.stripeConnectAccountId,
          },
          metadata: {
            invoiceId: invoice.id,
            workspaceId: workspace.id,
          },
        },
        success_url: `${process.env.APP_URL}/recievables/invoices/${invoice.id}?payment=success`,
        cancel_url: `${process.env.APP_URL}/recievables/invoices/${invoice.id}?payment=cancelled`,
        metadata: {
          invoiceId: invoice.id,
          workspaceId: workspace.id,
        },
      });

      res.json({ sessionId: session.id, url: session.url });
    } catch (error) {
      console.error("Error creating payment session:", error);
      res.status(500).json({ message: "Failed to create payment session", error: error instanceof Error ? error.message : String(error) });
    }
  });
  // Create Payment Intent for Stripe Elements
  app.post("/api/stripe/connect/create-payment-intent", isAuthenticated, async (req: any, res) => {
    try {
      const { invoiceId } = req.body;
      
      if (!invoiceId) {
        return res.status(400).json({ message: "Invoice ID is required" });
      }

      const invoice = await storage.getSalesInvoiceWithDetails(invoiceId);
      if (!invoice) {
        return res.status(404).json({ message: "Invoice not found" });
      }

      const workspace = await storage.getWorkspace(invoice.workspaceId);
      if (!workspace?.stripeConnectAccountId || !workspace.stripeConnectEnabled) {
        return res.status(400).json({ message: "Workspace does not have Stripe Connect enabled" });
      }

      // Get or create Stripe customer
      const customer = await storage.getCustomer(invoice.customerId);
      if (!customer) {
        return res.status(404).json({ message: "Customer not found" });
      }

      let stripeCustomerId = customer.stripeCustomerId;
      if (!stripeCustomerId) {
        // Create new Stripe customer if they don't have one
        const stripeCustomer = await stripe.customers.create({
          email: customer.email || undefined,
          name: customer.name,
          address: customer.billingAddress || customer.address ? {
            line1: customer.billingAddress || customer.address || undefined,
          } : undefined,
          metadata: {
            internalCustomerId: customer.id,
            workspaceId: customer.workspaceId,
          }
        }, {
          stripeAccount: workspace.stripeConnectAccountId,
        });

        // Update customer with Stripe customer ID
        await storage.updateCustomer(customer.id, {
          stripeCustomerId: stripeCustomer.id,
          stripeConnectAccountId: workspace.stripeConnectAccountId,
        });

        stripeCustomerId = stripeCustomer.id;
      }

      // Calculate application fee (4% as used elsewhere in the codebase)
      const applicationFeeAmount = Math.round(invoice.totalAmount * 0.04);

      // Create Payment Intent for Elements
      const paymentIntent = await stripe.paymentIntents.create({
        amount: invoice.totalAmount,
        currency: invoice.currency.toLowerCase(),
        customer: stripeCustomerId,
        automatic_payment_methods: {
          enabled: true,
        },
        application_fee_amount: applicationFeeAmount,
        description: `Invoice ${invoice.invoiceNumber} - ${invoice.title}`,
        metadata: {
          internalInvoiceId: invoice.id,
          internalInvoiceNumber: invoice.invoiceNumber,
          workspaceId: workspace.id,
          invoiceTitle: invoice.title,
        },
        // Set up for future payments if customer wants to save card
        setup_future_usage: 'off_session',
      }, {
        stripeAccount: workspace.stripeConnectAccountId,
      });

      console.log(`Created Payment Intent ${paymentIntent.id} for invoice ${invoice.invoiceNumber}`);

      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        applicationFeeAmount: applicationFeeAmount,
      });
    } catch (error) {
      console.error("Error creating payment intent:", error);
      res.status(500).json({ 
        message: "Failed to create payment intent", 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  });

  // ==================== ACCOUNTS RECEIVABLE ====================

  // AR Dashboard Statistics
  app.get("/api/recievables/dashboard/stats", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json({
          totalCustomers: 0,
          pendingInvoices: 0,
          overdueAmount: 0,
          monthlyRevenue: 0,
          avgCollectionTime: 0,
          recurringRevenue: 0,
          totalReceivable: 0,
          totalCollected: 0,
        });
      }

      const workspaceId = user.workspaceId;
      
      // Get customers count
      const customers = await storage.getCustomersByWorkspace(workspaceId);
      const totalCustomers = customers.length;

      // Get sales invoices
      const invoices = await storage.getSalesInvoicesByWorkspace(workspaceId);
      const pendingInvoices = invoices.filter(inv => ['draft', 'sent'].includes(inv.status)).length;
      const overdueInvoices = invoices.filter(inv => inv.status === 'overdue');
      const overdueAmount = overdueInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
      
      // Get this month's revenue (paid invoices)
      const thisMonth = new Date();
      thisMonth.setDate(1);
      thisMonth.setHours(0, 0, 0, 0);
      const monthlyInvoices = invoices.filter(inv => 
        inv.paidDate && new Date(inv.paidDate!) >= thisMonth
      );
      const monthlyRevenue = monthlyInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);

      // Calculate average collection time (in days)
      const paidInvoicesWithCollectionTime = invoices
        .filter(inv => inv.paidDate && inv.invoiceDate)
        .map(inv => {
          const invoiceDate = new Date(inv.invoiceDate);
          const paidDate = new Date(inv.paidDate!);
          return Math.ceil((paidDate.getTime() - invoiceDate.getTime()) / (1000 * 60 * 60 * 24));
        });
      
      const avgCollectionTime = paidInvoicesWithCollectionTime.length > 0 
        ? Math.round(paidInvoicesWithCollectionTime.reduce((sum, days) => sum + days, 0) / paidInvoicesWithCollectionTime.length)
        : 0;

      // Get recurring revenue
      const recurringInvoices = await storage.getRecurringInvoicesByWorkspace(workspaceId);
      const activeRecurring = recurringInvoices.filter(rinv => rinv.isActive);
      const recurringRevenue = activeRecurring.reduce((sum, rinv) => sum + rinv.totalAmount, 0);

      // Get total amounts
      const totalReceivable = invoices.reduce((sum, inv) => {
        if (['draft', 'sent', 'overdue'].includes(inv.status)) {
          return sum + inv.totalAmount;
        }
        return sum;
      }, 0);

      const totalCollected = invoices
        .filter(inv => inv.status === 'paid')
        .reduce((sum, inv) => sum + inv.totalAmount, 0);

      res.json({
        totalCustomers,
        pendingInvoices,
        overdueAmount,
        monthlyRevenue,
        avgCollectionTime,
        recurringRevenue,
        totalReceivable,
        totalCollected,
      });
    } catch (error) {
      console.error("Error fetching AR dashboard stats:", error);
      res.status(500).json({ message: "Failed to fetch AR dashboard statistics" });
    }
  });

  // Customer Management
  app.get("/api/recievables/customers", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json([]);
      }
      const customers = await storage.getCustomersByWorkspace(user.workspaceId);
      res.json(customers);
    } catch (error) {
      console.error("Error fetching customers:", error);
      res.status(500).json({ message: "Failed to fetch customers" });
    }
  });

  app.get("/api/recievables/customers/:id", isAuthenticated, async (req: any, res) => {
    try {
      const customer = await storage.getCustomer(req.params.id);
      if (!customer) {
        return res.status(404).json({ message: "Customer not found" });
      }
      res.json(customer);
    } catch (error) {
      console.error("Error fetching customer:", error);
      res.status(500).json({ message: "Failed to fetch customer" });
    }
  });

  app.post("/api/recievables/customers", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.status(400).json({ message: "User not in a workspace" });
      }

      // Validate that email is provided
      if (!req.body.email) {
        return res.status(400).json({ message: "Email is required for all customers" });
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(req.body.email)) {
        return res.status(400).json({ message: "Please provide a valid email address" });
      }

      const customer = await storage.createCustomer({
        ...req.body,
        workspaceId: user.workspaceId,
        createdById: userId,
      });

      res.json(customer);
    } catch (error) {
      console.error("Error creating customer:", error);
      res.status(500).json({ message: "Failed to create customer" });
    }
  });

  app.patch("/api/recievables/customers/:id", isAuthenticated, async (req: any, res) => {
    try {
      const customer = await storage.updateCustomer(req.params.id, req.body);
      if (!customer) {
        return res.status(404).json({ message: "Customer not found" });
      }
      res.json(customer);
    } catch (error) {
      console.error("Error updating customer:", error);
      res.status(500).json({ message: "Failed to update customer" });
    }
  });

  app.delete("/api/recievables/customers/:id", isAuthenticated, async (req: any, res) => {
    try {
      await storage.deleteCustomer(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting customer:", error);
      res.status(500).json({ message: "Failed to delete customer" });
    }
  });

  // Convert Issue to Customer
  app.post("/api/recievables/issues/:issueId/convert-to-customer", isAuthenticated, async (req: any, res) => {
    try {
      const customer = await storage.convertIssueToCustomer(req.params.issueId);
      if (!customer) {
        return res.status(400).json({ message: "Failed to convert issue to customer" });
      }
      res.json(customer);
    } catch (error) {
      console.error("Error converting issue to customer:", error);
      res.status(500).json({ message: "Failed to convert issue to customer" });
    }
  });

  // Sales Invoice Management
  app.get("/api/recievables/invoices", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json([]);
      }
      const invoices = await storage.getSalesInvoicesByWorkspace(user.workspaceId);
      res.json(invoices);
    } catch (error) {
      console.error("Error fetching invoices:", error);
      res.status(500).json({ message: "Failed to fetch invoices" });
    }
  });

  app.get("/api/recievables/invoices/:id", isAuthenticated, async (req: any, res) => {
    try {
      const invoice = await storage.getSalesInvoiceWithDetails(req.params.id);
      if (!invoice) {
        return res.status(404).json({ message: "Invoice not found" });
      }
      
      const lineItems = await storage.getSalesInvoiceLineItems(invoice.id);
      
      // Transform the data to match frontend expectations
      const transformedInvoice = {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        title: invoice.title,
        description: invoice.description,
        invoiceDate: invoice.invoiceDate?.toISOString() || new Date().toISOString(),
        dueDate: invoice.dueDate?.toISOString() || '',
        status: invoice.status,
        totalAmount: invoice.totalAmount,
        subtotal: invoice.totalAmount - (invoice.taxAmount || 0), // Calculate subtotal
        taxAmount: invoice.taxAmount,
        currency: invoice.currency,
        // Transform customer data to match frontend expectations
        customer: invoice.customer ? {
          name: invoice.customer.name,
          email: invoice.customer.email,
          address: invoice.customer.address,
          company: invoice.customer.industry || invoice.customer.name
        } : {
          name: 'Unknown Customer',
          email: '',
          address: '',
          company: ''
        },
        // Transform workspace data to match frontend expectations  
        workspace: invoice.workspace ? {
          name: invoice.workspace.name,
          email: invoice.workspace.billingEmail,
          address: invoice.workspace.bio || '',
          logoUrl: invoice.workspace.logoUrl
        } : {
          name: 'Unknown Workspace',
          email: '',
          address: '',
          logoUrl: ''
        },
        // Transform line items to match frontend expectations
        lineItems: lineItems.map(item => ({
          id: item.id,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          total: item.totalPrice
        }))
      };
      
      res.json(transformedInvoice);
    } catch (error) {
      console.error("Error fetching invoice:", error);
      res.status(500).json({ message: "Failed to fetch invoice" });
    }
  });

  app.post("/api/recievables/invoices", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.status(400).json({ message: "User not in a workspace" });
      }

      const { lineItems, taxPercentage, ...invoiceData } = req.body;

      // Validate that customer exists and has an email address
      if (!invoiceData.customerId) {
        return res.status(400).json({ message: "Customer is required" });
      }

      const customer = await storage.getCustomer(invoiceData.customerId);
      if (!customer) {
        return res.status(400).json({ message: "Customer not found" });
      }

      if (!customer.email) {
        return res.status(400).json({ 
          message: "Customer must have an email address to create invoices for sending",
          customerName: customer.name 
        });
      }
      
      // Generate invoice number if not provided
      if (!invoiceData.invoiceNumber) {
        invoiceData.invoiceNumber = generateInvoiceNumber(user.workspaceId);
      }

      let calculatedInvoiceData = { ...invoiceData };
      
      // If line items are provided, calculate totals automatically
      if (lineItems && Array.isArray(lineItems) && lineItems.length > 0) {
        // Validate line items
        const validationErrors = validateLineItems(lineItems);
        if (validationErrors.length > 0) {
          return res.status(400).json({ 
            message: "Invalid line items", 
            errors: validationErrors 
          });
        }

        // Calculate totals from line items
        const calculations = calculateInvoiceTotals(lineItems, taxPercentage || 0);
        
        // Override any manually entered amounts with calculated amounts
        calculatedInvoiceData = {
          ...calculatedInvoiceData,
          totalAmount: calculations.totalAmount,
          taxAmount: calculations.taxAmount,
        };
        
        console.log('Calculated invoice totals:', {
          subtotal: calculations.subtotal,
          taxAmount: calculations.taxAmount,
          totalAmount: calculations.totalAmount,
          lineItemsCount: lineItems.length
        });
      } else if (!invoiceData.totalAmount || invoiceData.totalAmount <= 0) {
        return res.status(400).json({ 
          message: "Either line items or total amount is required" 
        });
      }
      
      const invoice = await storage.createSalesInvoice({
        ...calculatedInvoiceData,
        workspaceId: user.workspaceId,
        createdById: userId,
      });

      // Create line items if provided
      if (lineItems && Array.isArray(lineItems)) {
        for (const item of lineItems) {
          await storage.createSalesInvoiceLineItem({
            ...item,
            invoiceId: invoice.id,
          });
        }
      }

      const invoiceWithItems = await storage.getSalesInvoiceWithDetails(invoice.id);
      const items = await storage.getSalesInvoiceLineItems(invoice.id);
      res.json({ ...invoiceWithItems, lineItems: items });
    } catch (error) {
      console.error("Error creating invoice:", error);
      res.status(500).json({ message: "Failed to create invoice" });
    }
  });

  // Publish/Send Invoice
  app.post("/api/recievables/invoices/:id/publish", isAuthenticated, async (req: any, res) => {
    try {
      const invoice = await storage.getSalesInvoiceWithDetails(req.params.id);
      if (!invoice) {
        return res.status(404).json({ message: "Invoice not found" });
      }

      if (invoice.status !== 'draft') {
        return res.status(400).json({ message: "Only draft invoices can be published" });
      }

      // Update invoice status to 'sent'
      const updatedInvoice = await storage.updateSalesInvoice(req.params.id, {
        status: 'sent',
        sentDate: new Date(),
      });

      // Send email to customer if they have an email address
      if (invoice.customer?.email) {
        try {
          const protocol = req.protocol;
          const host = req.get("host");
          const invoiceUrl = `${protocol}://${host}/recievables/invoices/${invoice.id}`;
          
          console.log(`Sending invoice email to ${invoice.customer.email} for invoice ${invoice.invoiceNumber}`);
          
          // Send the actual email using Resend
          await sendInvoiceEmail(
            invoice.customer.email,
            invoice.invoiceNumber,
            invoiceUrl,
            invoice.customer.name,
            invoice.totalAmount,
            invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : 'N/A',
            new Date(invoice.invoiceDate).toLocaleDateString(),
            invoice.workspace?.name || 'Your Company'
          );
          
          console.log(`Successfully sent invoice email to ${invoice.customer.email}`);
          
        } catch (emailError) {
          console.error("Failed to send invoice email:", emailError);
          // Don't fail the entire request if email sending fails
        }
      }

      res.json(updatedInvoice);
    } catch (error) {
      console.error("Error publishing invoice:", error);
      res.status(500).json({ message: "Failed to publish invoice" });
    }
  });

  app.patch("/api/recievables/invoices/:id", isAuthenticated, async (req: any, res) => {
    try {
      const { lineItems, taxPercentage, ...updateData } = req.body;
      
      // If line items are provided, recalculate totals
      if (lineItems && Array.isArray(lineItems) && lineItems.length > 0) {
        // Validate line items
        const validationErrors = validateLineItems(lineItems);
        if (validationErrors.length > 0) {
          return res.status(400).json({ 
            message: "Invalid line items", 
            errors: validationErrors 
          });
        }

        // Calculate totals from line items
        const calculations = calculateInvoiceTotals(lineItems, taxPercentage || 0);
        
        // Override any manually entered amounts with calculated amounts
        updateData.totalAmount = calculations.totalAmount;
        updateData.taxAmount = calculations.taxAmount;
        
        console.log('Updated invoice totals:', {
          subtotal: calculations.subtotal,
          taxAmount: calculations.taxAmount,
          totalAmount: calculations.totalAmount,
          lineItemsCount: lineItems.length
        });
      }
      
      const invoice = await storage.updateSalesInvoice(req.params.id, updateData);
      if (!invoice) {
        return res.status(404).json({ message: "Invoice not found" });
      }

      // If line items are provided, update them (delete existing and create new)
      if (lineItems && Array.isArray(lineItems)) {
        // Delete existing line items
        await storage.deleteSalesInvoiceLineItems(req.params.id);
        
        // Create new line items
        for (const item of lineItems) {
          await storage.createSalesInvoiceLineItem({
            ...item,
            invoiceId: req.params.id,
          });
        }
      }

      const invoiceWithItems = await storage.getSalesInvoiceWithDetails(req.params.id);
      const items = await storage.getSalesInvoiceLineItems(req.params.id);
      res.json({ ...invoiceWithItems, lineItems: items });
    } catch (error) {
      console.error("Error updating invoice:", error);
      res.status(500).json({ message: "Failed to update invoice" });
    }
  });

  app.delete("/api/recievables/invoices/:id", isAuthenticated, async (req: any, res) => {
    try {
      await storage.deleteSalesInvoice(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting invoice:", error);
      res.status(500).json({ message: "Failed to delete invoice" });
    }
  });
  // PDF generation removed - now using hosted pages approach
  // Users can view invoices at /recievables/invoices/:id and download as PDF using browser print function



  // Recurring Invoice Management
  app.get("/api/recievables/recurring-invoices", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json([]);
      }
      const recurringInvoices = await storage.getRecurringInvoicesByWorkspace(user.workspaceId);
      res.json(recurringInvoices);
    } catch (error) {
      console.error("Error fetching recurring invoices:", error);
      res.status(500).json({ message: "Failed to fetch recurring invoices" });
    }
  });

  app.post("/api/recievables/recurring-invoices", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.status(400).json({ message: "User not in a workspace" });
      }

      const recurringInvoice = await storage.createRecurringInvoice({
        ...req.body,
        workspaceId: user.workspaceId,
        createdById: userId,
      });

      res.json(recurringInvoice);
    } catch (error) {
      console.error("Error creating recurring invoice:", error);
      res.status(500).json({ message: "Failed to create recurring invoice" });
    }
  });

  app.patch("/api/recievables/recurring-invoices/:id", isAuthenticated, async (req: any, res) => {
    try {
      const recurringInvoice = await storage.updateRecurringInvoice(req.params.id, req.body);
      if (!recurringInvoice) {
        return res.status(404).json({ message: "Recurring invoice not found" });
      }
      res.json(recurringInvoice);
    } catch (error) {
      console.error("Error updating recurring invoice:", error);
      res.status(500).json({ message: "Failed to update recurring invoice" });
    }
  });

  // Customer Payment Management
  app.get("/api/recievables/payments", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json([]);
      }
      const payments = await storage.getCustomerPaymentsByWorkspace(user.workspaceId);
      res.json(payments);
    } catch (error) {
      console.error("Error fetching payments:", error);
      res.status(500).json({ message: "Failed to fetch payments" });
    }
  });

  app.post("/api/recievables/payments", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.status(400).json({ message: "User not in a workspace" });
      }

      const payment = await storage.createCustomerPayment({
        ...req.body,
        workspaceId: user.workspaceId,
        createdById: userId,
      });

      // Update invoice status if payment is for a specific invoice
      if (payment.invoiceId) {
        const invoice = await storage.getSalesInvoice(payment.invoiceId);
        if (invoice) {
          const totalPaid = payment.amount;
          if (totalPaid >= invoice.totalAmount) {
            await storage.updateSalesInvoice(payment.invoiceId, { 
              status: 'paid',
              paidDate: payment.paymentDate 
            });
          }
        }
      }

      res.json(payment);
    } catch (error) {
      console.error("Error creating payment:", error);
      res.status(500).json({ message: "Failed to create payment" });
    }
  });

  // Payment Method Management
  app.get("/api/recievables/payment-methods/:customerId", isAuthenticated, async (req: any, res) => {
    try {
      const paymentMethods = await storage.getPaymentMethodsByCustomer(req.params.customerId);
      res.json(paymentMethods);
    } catch (error) {
      console.error("Error fetching payment methods:", error);
      res.status(500).json({ message: "Failed to fetch payment methods" });
    }
  });

  app.post("/api/recievables/payment-methods", isAuthenticated, async (req: any, res) => {
    try {
      const paymentMethod = await storage.createPaymentMethod(req.body);
      res.json(paymentMethod);
    } catch (error) {
      console.error("Error creating payment method:", error);
      res.status(500).json({ message: "Failed to create payment method" });
    }
  });

  app.patch("/api/recievables/payment-methods/:id", isAuthenticated, async (req: any, res) => {
    try {
      const paymentMethod = await storage.updatePaymentMethod(req.params.id, req.body);
      if (!paymentMethod) {
        return res.status(404).json({ message: "Payment method not found" });
      }
      res.json(paymentMethod);
    } catch (error) {
      console.error("Error updating payment method:", error);
      res.status(500).json({ message: "Failed to update payment method" });
    }
  });

  // AR Reports and Analytics
  app.get("/api/recievables/reports/aging", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json({ current: 0, thirty: 0, sixty: 0, ninety: 0, overNinety: 0 });
      }

      const invoices = await storage.getSalesInvoicesByWorkspace(user.workspaceId);
      const now = new Date();
      
      let current = 0;
      let thirty = 0;
      let sixty = 0;
      let ninety = 0;
      let overNinety = 0;

      invoices.forEach(invoice => {
        if (['draft', 'sent', 'overdue'].includes(invoice.status) && invoice.dueDate) {
          const dueDate = new Date(invoice.dueDate);
          const daysPastDue = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
          
          if (daysPastDue <= 0) {
            current += invoice.totalAmount;
          } else if (daysPastDue <= 30) {
            thirty += invoice.totalAmount;
          } else if (daysPastDue <= 60) {
            sixty += invoice.totalAmount;
          } else if (daysPastDue <= 90) {
            ninety += invoice.totalAmount;
          } else {
            overNinety += invoice.totalAmount;
          }
        }
      });

      res.json({ current, thirty, sixty, ninety, overNinety });
    } catch (error) {
      console.error("Error generating aging report:", error);
      res.status(500).json({ message: "Failed to generate aging report" });
    }
  });

  app.get("/api/recievables/reports/collection-insights", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json({ totalCollected: 0, avgPaymentTime: 0, paymentMethods: [], topCustomers: [] });
      }

      const payments = await storage.getCustomerPaymentsByWorkspace(user.workspaceId);
      const invoices = await storage.getSalesInvoicesByWorkspace(user.workspaceId);
      
      const totalCollected = payments.reduce((sum, payment) => sum + payment.amount, 0);
      
      // Calculate average payment time
      const paidInvoices = invoices.filter(inv => inv.paidDate && inv.invoiceDate);
      const paymentTimes = paidInvoices.map(inv => {
        const invoiceDate = new Date(inv.invoiceDate);
        const paidDate = new Date(inv.paidDate!);
        return Math.ceil((paidDate.getTime() - invoiceDate.getTime()) / (1000 * 60 * 60 * 24));
      });
      const avgPaymentTime = paymentTimes.length > 0 
        ? Math.round(paymentTimes.reduce((sum, days) => sum + days, 0) / paymentTimes.length)
        : 0;

      // Payment method distribution
      const paymentMethods: { [key: string]: number } = {};
      payments.forEach(payment => {
        paymentMethods[payment.method] = (paymentMethods[payment.method] || 0) + payment.amount;
      });

      res.json({
        totalCollected,
        avgPaymentTime,
        paymentMethods,
        topCustomers: [], // This would require more complex aggregation
      });
    } catch (error) {
      console.error("Error generating collection insights:", error);
      res.status(500).json({ message: "Failed to generate collection insights" });
    }
  });

  // Stripe Connect account link generation
  app.post("/api/stripe/connect/generate-account-link", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      
      if (!user?.workspaceId || !user.isAdmin) {
        return res.status(403).json({ message: "Not authorized" });
      }

      const workspace = await storage.getWorkspace(user.workspaceId);
      if (!workspace?.stripeConnectAccountId) {
        return res.status(400).json({ message: "No Stripe Connect account found" });
      }

      // Fetch fresh account details to determine current requirements
      const account = await stripe.accounts.retrieve(workspace.stripeConnectAccountId);
      
      // Determine the appropriate link type based on current account state
      let linkType = 'account_onboarding';
      let refreshUrl = `${process.env.APP_URL}/settings?stripe_connect=refresh`;
      let returnUrl = `${process.env.APP_URL}/settings?stripe_connect=success`;

      // If account needs verification or has past due requirements, use verification flow
      if ((account.requirements?.currently_due?.length || 0) > 0 || (account.requirements?.past_due?.length || 0) > 0) {
        linkType = 'account_onboarding'; // This handles both onboarding and verification
        refreshUrl = `${process.env.APP_URL}/settings?stripe_connect=verification_refresh`;
        returnUrl = `${process.env.APP_URL}/settings?stripe_connect=verification_complete`;
      }

      // Generate account link using Stripe Connect
      const accountLink = await stripe.accountLinks.create({
        account: workspace.stripeConnectAccountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: linkType as any,
      });

      // Store the account link and expiration
      const linkExpiration = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days from now
      await storage.updateWorkspace(workspace.id, {
        stripeConnectAccountLink: accountLink.url,
        stripeConnectAccountLinkExpires: linkExpiration,
      });

      // Update requirements from Stripe
      await storage.updateWorkspace(workspace.id, {
        stripeConnectRequirementsCurrentlyDue: account.requirements?.currently_due || [],
        stripeConnectRequirementsEventuallyDue: account.requirements?.eventually_due || [],
        stripeConnectRequirementsPastDue: account.requirements?.past_due || [],
      });

      // Track the account link generation
      const currentEvents = Array.isArray(workspace.stripeConnectOnboardingEvents) ? workspace.stripeConnectOnboardingEvents : [];
      await storage.updateWorkspace(workspace.id, {
        stripeConnectOnboardingEvents: [...currentEvents, {
          event: 'account_link.generated',
          timestamp: new Date().toISOString(),
          data: {
            account_id: workspace.stripeConnectAccountId,
            link_type: linkType,
            requirements_due: account.requirements?.currently_due || [],
            expires_at: linkExpiration.toISOString(),
          }
        }]
      });

      console.log(`Generated account link for workspace ${workspace.id}`);
      
      res.json({
        accountLink: accountLink.url,
        linkType: linkType,
        expiresAt: linkExpiration.toISOString(),
      });
    } catch (error) {
      console.error("Error generating account link:", error);
      res.status(500).json({ message: "Failed to generate account link" });
    }
  });

  // Procurement (Purchase Requisitions / Purchase Orders)
  app.get("/api/procurement/requisitions", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json([]);
      }
      const requisitions = await storage.getPurchaseRequisitionsByWorkspace(user.workspaceId);
      res.json(requisitions);
    } catch (error) {
      console.error("Error fetching requisitions:", error);
      res.status(500).json({ message: "Failed to fetch requisitions" });
    }
  });

  app.post("/api/procurement/requisitions", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.status(403).json({ message: "No workspace found" });
      }

      const parseAmount = (value: any) => {
        if (value === undefined || value === null || value === "") return 0;
        const numeric = typeof value === "string" ? parseFloat(value) : Number(value);
        return Number.isNaN(numeric) ? 0 : Math.round(numeric * 100);
      };

      const requisition = await storage.createPurchaseRequisition({
        workspaceId: user.workspaceId,
        requisitionNumber:
          req.body.requisitionNumber || `REQ-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(2)}`,
        title: req.body.title,
        description: req.body.description,
        requestedById: userId,
        department: req.body.department,
        urgency: req.body.urgency || "normal",
        status: req.body.status || "submitted",
        totalEstimatedAmount: parseAmount(req.body.totalEstimatedAmount),
        currency: req.body.currency || "USD",
        neededByDate: req.body.neededByDate ? new Date(req.body.neededByDate) : null,
        approvedById: null,
        approvedAt: null,
        rejectedReason: null,
      });

      res.json(requisition);
    } catch (error) {
      console.error("Error creating requisition:", error);
      res.status(500).json({ message: "Failed to create requisition" });
    }
  });

  app.get("/api/procurement/purchase-orders", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.json([]);
      }
      const purchaseOrders = await storage.getPurchaseOrdersByWorkspace(user.workspaceId);
      res.json(purchaseOrders);
    } catch (error) {
      console.error("Error fetching purchase orders:", error);
      res.status(500).json({ message: "Failed to fetch purchase orders" });
    }
  });

  app.post("/api/procurement/purchase-orders", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      if (!user?.workspaceId) {
        return res.status(403).json({ message: "No workspace found" });
      }

      if (!req.body.vendorId) {
        return res.status(400).json({ message: "vendorId is required" });
      }

      const parseAmount = (value: any) => {
        if (value === undefined || value === null || value === "") return 0;
        const numeric = typeof value === "string" ? parseFloat(value) : Number(value);
        return Number.isNaN(numeric) ? 0 : Math.round(numeric * 100);
      };

      const po = await storage.createPurchaseOrder({
        workspaceId: user.workspaceId,
        poNumber: req.body.poNumber || `PO-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(2)}`,
        vendorId: req.body.vendorId,
        title: req.body.title,
        description: req.body.description,
        status: req.body.status || "draft",
        totalAmount: parseAmount(req.body.totalAmount),
        currency: req.body.currency || "USD",
        requestedDeliveryDate: req.body.requestedDeliveryDate ? new Date(req.body.requestedDeliveryDate) : null,
        approvedById: null,
        approvedAt: null,
        createdById: userId,
      });

      res.json(po);
    } catch (error) {
      console.error("Error creating purchase order:", error);
      res.status(500).json({ message: "Failed to create purchase order" });
    }
  });

  app.get("/api/stripe/connect/verification-status", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      
      if (!user?.workspaceId || !user.isAdmin) {
        return res.status(403).json({ message: "Not authorized" });
      }

      const workspace = await storage.getWorkspace(user.workspaceId);
      
      if (!workspace?.stripeConnectAccountId) {
        return res.status(400).json({ message: "No Stripe Connect account found" });
      }

      // Fetch fresh account details from Stripe
      const account = await stripe.accounts.retrieve(workspace.stripeConnectAccountId);
      
      // Check if account link has expired
      const linkExpired = workspace.stripeConnectAccountLinkExpires
        ? new Date(workspace.stripeConnectAccountLinkExpires) < new Date()
        : true;

      const response = {
        accountId: account.id,
        requirements: {
          currentlyDue: account.requirements?.currently_due || [],
          eventuallyDue: account.requirements?.eventually_due || [],
          pastDue: account.requirements?.past_due || [],
        },
        verificationFields: account.requirements?.disabled_reason || [],
        onboardingStatus: workspace.stripeConnectOnboardingStatus,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        detailsSubmitted: account.details_submitted,
        accountLink: linkExpired ? null : workspace.stripeConnectAccountLink,
        linkExpired,
        lastWebhookEvent: workspace.stripeConnectLastWebhookEvent,
        lastWebhookTimestamp: workspace.stripeConnectLastWebhookTimestamp,
      };

      res.json(response);
    } catch (error) {
      console.error("Error fetching verification status:", error);
      res.status(500).json({ message: "Failed to fetch verification status" });
    }
  });

  // ==================== STRIPE INVOICING CONNECT ====================

  // Create or get Stripe customer for existing customer
  app.post("/api/stripe/invoicing/create-customer", isAuthenticated, async (req: any, res) => {
    try {
      const { customerId } = req.body;
      
      if (!customerId) {
        return res.status(400).json({ message: "Customer ID is required" });
      }

      const customer = await storage.getCustomer(customerId);
      if (!customer) {
        return res.status(404).json({ message: "Customer not found" });
      }

      const workspace = await storage.getWorkspace(customer.workspaceId);
      if (!workspace?.stripeConnectAccountId) {
        return res.status(400).json({ message: "Workspace does not have Stripe Connect enabled" });
      }

      // If customer already has a Stripe customer ID, return it
      if (customer.stripeCustomerId) {
        return res.json({ 
          stripeCustomerId: customer.stripeCustomerId,
          existing: true 
        });
      }

      // Create new Stripe customer
      const stripeCustomer = await stripe.customers.create({
        email: customer.email || undefined,
        name: customer.name,
        address: customer.billingAddress || customer.address ? {
          line1: customer.billingAddress || customer.address || undefined,
        } : undefined,
        metadata: {
          internalCustomerId: customer.id,
          workspaceId: customer.workspaceId,
        }
      }, {
        stripeAccount: workspace.stripeConnectAccountId,
      });

      // Update customer with Stripe customer ID
      await storage.updateCustomer(customerId, {
        stripeCustomerId: stripeCustomer.id,
        stripeConnectAccountId: workspace.stripeConnectAccountId,
      });

      res.json({ 
        stripeCustomerId: stripeCustomer.id,
        existing: false 
      });
    } catch (error) {
      console.error("Error creating Stripe customer:", error);
      res.status(500).json({ message: "Failed to create Stripe customer", error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Create Stripe invoice and send to customer
  app.post("/api/stripe/invoicing/create-and-send-invoice", isAuthenticated, async (req: any, res) => {
    try {
      const { invoiceId } = req.body;
      
      if (!invoiceId) {
        return res.status(400).json({ message: "Invoice ID is required" });
      }

      const invoice = await storage.getSalesInvoiceWithDetails(invoiceId);
      if (!invoice) {
        return res.status(404).json({ message: "Invoice not found" });
      }

      const workspace = await storage.getWorkspace(invoice.workspaceId);
      if (!workspace?.stripeConnectAccountId) {
        return res.status(400).json({ message: "Workspace does not have Stripe Connect enabled" });
      }

      // Get customer and ensure they have a Stripe customer ID
      const customer = await storage.getCustomer(invoice.customerId);
      if (!customer?.stripeCustomerId) {
        return res.status(400).json({ message: "Customer must have a Stripe customer ID" });
      }

      // Get line items for the invoice
      const lineItems = await storage.getSalesInvoiceLineItems(invoice.id);

      // Create Stripe invoice
      const stripeInvoice = await stripe.invoices.create({
        customer: customer.stripeCustomerId,
        auto_advance: true, // Automatically finalize and attempt payment
        collection_method: 'send_invoice',
        days_until_due: invoice.dueDate ? Math.ceil((new Date(invoice.dueDate).getTime() - new Date(invoice.invoiceDate).getTime()) / (1000 * 60 * 60 * 24)) : 30,
        application_fee_amount: Math.round(invoice.totalAmount * 0.04), // 4% application fee
        metadata: {
          internalInvoiceId: invoice.id,
          workspaceId: invoice.workspaceId,
        }
      }, {
        stripeAccount: workspace.stripeConnectAccountId,
      });

      // Add line items to the invoice using simple invoice items
      for (const item of lineItems) {
        try {
          // Use amount (total price) with description for simple invoice items
          // This approach works reliably without requiring product creation
          await stripe.invoiceItems.create({
            customer: customer.stripeCustomerId,
            invoice: stripeInvoice.id,
            amount: item.totalPrice, // Use total price for the line item
            currency: invoice.currency.toLowerCase(),
            description: item.description,
          }, {
            stripeAccount: workspace.stripeConnectAccountId,
          });
        } catch (itemError) {
          console.error(`Failed to create invoice item for "${item.description}":`, itemError);
          // Continue with other items even if one fails
          const errorMessage = itemError instanceof Error ? itemError.message : String(itemError);
          throw new Error(`Failed to add line item "${item.description}": ${errorMessage}`);
        }
      }

      // Finalize the invoice
      const finalizedInvoice = await stripe.invoices.finalizeInvoice(stripeInvoice.id, {}, {
        stripeAccount: workspace.stripeConnectAccountId,
      });

      // Send the invoice to the customer
      await stripe.invoices.sendInvoice(finalizedInvoice.id, {}, {
        stripeAccount: workspace.stripeConnectAccountId,
      });

      // Update internal invoice with Stripe data
      await storage.updateSalesInvoice(invoiceId, {
        stripeInvoiceId: finalizedInvoice.id,
        stripeConnectAccountId: workspace.stripeConnectAccountId,
        stripeHostedInvoiceUrl: finalizedInvoice.hosted_invoice_url,
        stripeInvoicePdf: finalizedInvoice.invoice_pdf,
        stripePaymentStatus: (finalizedInvoice as any).payment_status,
        stripeAmountDue: finalizedInvoice.amount_due,
        stripeAmountPaid: finalizedInvoice.amount_paid,
        stripeApplicationFeeAmount: (finalizedInvoice as any).application_fee_amount,
        status: 'sent',
        sentDate: new Date(),
      });

      res.json({
        stripeInvoiceId: finalizedInvoice.id,
        hostedInvoiceUrl: finalizedInvoice.hosted_invoice_url,
        invoicePdf: finalizedInvoice.invoice_pdf,
      });
    } catch (error) {
      console.error("Error creating Stripe invoice:", error);
      res.status(500).json({ message: "Failed to create Stripe invoice", error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Update invoice status from Stripe webhook
  app.post("/api/stripe/invoicing/webhook", async (req, res) => {
    const sig = req.headers['stripe-signature'] as string;
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret!);
    } catch (err) {
      console.log(`Webhook signature verification failed.`, err);
      return res.status(400).send('Webhook Error');
    }

    try {
      switch (event.type) {
        case 'invoice.created': {
          const stripeInvoice = event.data.object as any;
          console.log('Stripe invoice created:', stripeInvoice.id);
          
          if (stripeInvoice.metadata?.internalInvoiceId) {
            const invoiceId = stripeInvoice.metadata.internalInvoiceId;
            
            await storage.updateSalesInvoice(invoiceId, {
              stripePaymentStatus: stripeInvoice.payment_status,
              stripeAmountDue: stripeInvoice.amount_due,
            });
          }
          break;
        }

        case 'invoice.finalized': {
          const stripeInvoice = event.data.object as any;
          console.log('Stripe invoice finalized:', stripeInvoice.id);
          
          if (stripeInvoice.metadata?.internalInvoiceId) {
            const invoiceId = stripeInvoice.metadata.internalInvoiceId;
            
            await storage.updateSalesInvoice(invoiceId, {
              stripePaymentStatus: stripeInvoice.payment_status,
              stripeAmountDue: stripeInvoice.amount_due,
              stripeHostedInvoiceUrl: stripeInvoice.hosted_invoice_url,
              stripeInvoicePdf: stripeInvoice.invoice_pdf,
            });
          }
          break;
        }

        case 'invoice.payment_succeeded': {
          const stripeInvoice = event.data.object as any;
          console.log('Stripe invoice payment succeeded:', stripeInvoice.id);
          
          if (stripeInvoice.metadata?.internalInvoiceId) {
            const invoiceId = stripeInvoice.metadata.internalInvoiceId;
            
            // Update invoice status to paid
            await storage.updateSalesInvoice(invoiceId, {
              status: 'paid',
              paidDate: new Date(),
              stripePaymentStatus: stripeInvoice.payment_status,
              stripeAmountPaid: stripeInvoice.amount_paid,
              stripeAmountDue: stripeInvoice.amount_due,
            });

            // Create customer payment record
            const invoice = await storage.getSalesInvoice(invoiceId);
            if (invoice) {
              await storage.createCustomerPayment({
                workspaceId: invoice.workspaceId,
                customerId: invoice.customerId,
                invoiceId: invoiceId,
                amount: stripeInvoice.amount_paid,
                currency: stripeInvoice.currency.toUpperCase(),
                method: 'stripe_invoice',
                paymentDate: new Date(),
                externalTransactionId: stripeInvoice.id,
                createdById: null,
              });
            }
          }
          break;
        }

        case 'invoice.payment_failed': {
          const stripeInvoice = event.data.object as any;
          console.log('Stripe invoice payment failed:', stripeInvoice.id);
          
          if (stripeInvoice.metadata?.internalInvoiceId) {
            const invoiceId = stripeInvoice.metadata.internalInvoiceId;
            
            await storage.updateSalesInvoice(invoiceId, {
              status: 'overdue',
              stripePaymentStatus: stripeInvoice.payment_status,
              stripeAmountDue: stripeInvoice.amount_due,
            });
          }
          break;
        }

        case 'invoice.payment_action_required': {
          const stripeInvoice = event.data.object as any;
          console.log('Stripe invoice payment action required:', stripeInvoice.id);
          
          if (stripeInvoice.metadata?.internalInvoiceId) {
            const invoiceId = stripeInvoice.metadata.internalInvoiceId;
            
            await storage.updateSalesInvoice(invoiceId, {
              stripePaymentStatus: stripeInvoice.payment_status,
              stripeAmountDue: stripeInvoice.amount_due,
            });
          }
          break;
        }

        case 'invoice.sent': {
          const stripeInvoice = event.data.object as any;
          console.log('Stripe invoice sent:', stripeInvoice.id);
          
          if (stripeInvoice.metadata?.internalInvoiceId) {
            const invoiceId = stripeInvoice.metadata.internalInvoiceId;
            
            await storage.updateSalesInvoice(invoiceId, {
              status: 'sent',
              sentDate: new Date(),
              stripePaymentStatus: stripeInvoice.payment_status,
            });
          }
          break;
        }

        case 'invoice.voided': {
          const stripeInvoice = event.data.object as any;
          console.log('Stripe invoice voided:', stripeInvoice.id);
          
          if (stripeInvoice.metadata?.internalInvoiceId) {
            const invoiceId = stripeInvoice.metadata.internalInvoiceId;
            
            await storage.updateSalesInvoice(invoiceId, {
              status: 'cancelled',
            });
          }
          break;
        }

        default:
          console.log(`Unhandled Stripe invoice event type ${event.type}`);
      }

      res.json({ received: true });
    } catch (error) {
      console.error('Error processing Stripe invoice webhook:', error);
      res.status(500).json({ error: 'Webhook handler failed' });
    }
  });

  return httpServer;
}
