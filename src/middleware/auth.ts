import { Request, Response, NextFunction } from "express";
import { verifyToken, JwtPayload } from "../utils/auth";
import prisma from "../utils/prisma";

export interface AuthRequest extends Request {
  user?: JwtPayload;
  businessId?: string;
}

export async function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    let token: string | undefined;

    if (req.cookies?.BillMint_token) {
      token = req.cookies.BillMint_token;
    } else if (req.headers.authorization?.startsWith("Bearer ")) {
      token = req.headers.authorization.slice(7);
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const payload = verifyToken(token);

    const user = await prisma.user.findFirst({
      where: {
        id: payload.userId,
        deletedAt: null,
        status: "ACTIVE",
      },
      select: { id: true },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found or inactive",
      });
    }

    const member = await prisma.businessMember.findFirst({
      where: {
        id: payload.memberId,
        userId: payload.userId,
        businessId: payload.businessId,
        status: "ACTIVE",
        business: {
          deletedAt: null,
        },
      },
      select: { id: true },
    });

    if (!member) {
      return res.status(401).json({
        success: false,
        message: "Business membership not found",
      });
    }

    req.user = payload;
    req.businessId = payload.businessId;

    return next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired session",
    });
  }
}

/**
 * Enforces permissions from the active business role.
 * Owner status alone is not permission to bypass sensitive checks.
 */
export function requirePermission(...codes: string[]) {
  return async (
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ) => {
    if (!req.user || !req.businessId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    try {
      const membership = await prisma.businessMember.findFirst({
        where: {
          id: req.user.memberId,
          userId: req.user.userId,
          businessId: req.businessId,
          status: "ACTIVE",
        },
        include: {
          role: {
            include: {
              permissions: {
                include: {
                  permission: true,
                },
              },
            },
          },
        },
      });

      if (!membership) {
        return res.status(403).json({
          success: false,
          message: "Active business membership required",
        });
      }

      const userPermissions = new Set(
        membership.role.permissions.map(
          (entry) => entry.permission.code,
        ),
      );

      const allowed = codes.every(
        (code) =>
          userPermissions.has(code) ||
          userPermissions.has("*"),
      );

      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: "Insufficient permissions",
        });
      }

      return next();
    } catch (error) {
      console.error("[AUTH] Permission check failed:", error);

      return res.status(500).json({
        success: false,
        message: "Permission check failed",
      });
    }
  };
}

/**
 * Store-level restriction. This is independent of role names
 * and cannot be bypassed merely because a user is an owner.
 */
export function requireStoreRole(...allowedRoles: string[]) {
  return async (
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ) => {
    if (!req.businessId) {
      return res.status(401).json({
        success: false,
        message: "Business context is missing",
      });
    }

    try {
      const business = await prisma.business.findFirst({
        where: {
          id: req.businessId,
          deletedAt: null,
        },
        select: {
          storeRole: true,
        },
      });

      if (!business) {
        return res.status(404).json({
          success: false,
          message: "Business not found",
        });
      }

      if (!allowedRoles.includes(business.storeRole)) {
        return res.status(403).json({
          success: false,
          message: "This operation is not permitted for this store",
        });
      }

      return next();
    } catch (error) {
      console.error("[AUTH] Store-role check failed:", error);

      return res.status(500).json({
        success: false,
        message: "Store access check failed",
      });
    }
  };
}