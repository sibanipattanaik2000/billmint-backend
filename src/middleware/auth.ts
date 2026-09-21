import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../utils/auth';
import prisma from '../utils/prisma';

export interface AuthRequest extends Request {
  user?: JwtPayload;
  businessId?: string;
}

export async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    let token: string | undefined;

    // Prefer HTTP-only cookie
    if (req.cookies?.BillMint_token) {
      token = req.cookies.BillMint_token;
    } else if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.slice(7);
    }

    if (!token) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const payload = verifyToken(token);

    // Verify user still active
    const user = await prisma.user.findFirst({
      where: { id: payload.userId, deletedAt: null, status: 'ACTIVE' },
    });

    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found or inactive' });
    }

    // Verify membership
    const member = await prisma.businessMember.findFirst({
      where: {
        id: payload.memberId,
        userId: payload.userId,
        businessId: payload.businessId,
        status: 'ACTIVE',
      },
    });

    if (!member) {
      return res.status(401).json({ success: false, message: 'Business membership not found' });
    }

    req.user = payload;
    req.businessId = payload.businessId;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired session' });
  }
}

export function requirePermission(...codes: string[]) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    // Owners bypass permission checks
    if (req.user.isOwner) {
      return next();
    }

    try {
      const role = await prisma.role.findFirst({
        where: {
          businessId: req.user.businessId,
          name: req.user.role,
        },
        include: {
          permissions: {
            include: { permission: true },
          },
        },
      });

      if (!role) {
        return res.status(403).json({ success: false, message: 'Role not found' });
      }

      const userPerms = new Set(role.permissions.map((rp) => rp.permission.code));
      const hasAll = codes.every((c) => userPerms.has(c) || userPerms.has('*'));

      if (!hasAll) {
        return res.status(403).json({ success: false, message: 'Insufficient permissions' });
      }

      next();
    } catch {
      return res.status(500).json({ success: false, message: 'Permission check failed' });
    }
  };
}
