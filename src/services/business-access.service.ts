
import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";
import { JwtPayload, signToken } from "../utils/auth";

/**
 * Return every active company the authenticated account can access.
 * Company data is limited to the fields needed by the company switcher.
 */
export async function getMyBusinesses(userId: string, activeBusinessId: string) {
  const memberships = await prisma.businessMember.findMany({
    where: {
      userId,
      status: "ACTIVE",
      business: {
        deletedAt: null,
      },
    },
    include: {
      business: {
        select: {
          id: true,
          name: true,
          storeCode: true,
          city: true,
          state: true,
          gstin: true,
          setupCompleted: true,
        },
      },
      role: {
        select: {
          name: true,
        },
      },
    },
    orderBy: {
      joinedAt: "asc",
    },
  });

  return memberships.map((membership) => ({
    membershipId: membership.id,
    businessId: membership.businessId,
    name: membership.business.name,
    storeCode: membership.business.storeCode,
    city: membership.business.city,
    state: membership.business.state,
    gstin: membership.business.gstin,
    setupCompleted: membership.business.setupCompleted,
    role: membership.role.name,
    isOwner: membership.isOwner,
    isActive: membership.businessId === activeBusinessId,
  }));
}

/**
 * Switch the authenticated account to another company.
 * The account must have an active membership in the requested company.
 */
export async function switchBusiness(
  currentUser: JwtPayload,
  targetBusinessId: string,
) {
  if (!targetBusinessId || typeof targetBusinessId !== "string") {
    throw new AppError("A valid company is required", 400);
  }

  const membership = await prisma.businessMember.findFirst({
    where: {
      userId: currentUser.userId,
      businessId: targetBusinessId,
      status: "ACTIVE",
      business: {
        deletedAt: null,
      },
    },
    include: {
      business: {
        select: {
          id: true,
          name: true,
          storeCode: true,
          city: true,
          state: true,
          gstin: true,
          setupCompleted: true,
        },
      },
      role: {
        select: {
          name: true,
        },
      },
    },
  });

  if (!membership) {
    throw new AppError(
      "You do not have access to this company",
      403,
    );
  }

  const tokenPayload: JwtPayload = {
    userId: currentUser.userId,
    businessId: membership.businessId,
    memberId: membership.id,
    role: membership.role.name,
    isOwner: membership.isOwner,
  };

  const token = signToken(tokenPayload);

  await prisma.auditLog.create({
    data: {
      businessId: membership.businessId,
      userId: currentUser.userId,
      action: "SWITCH_COMPANY",
      module: "auth",
      recordId: membership.businessId,
      recordName: membership.business.name,
      details: JSON.stringify({
        previousBusinessId: currentUser.businessId,
        newBusinessId: membership.businessId,
      }),
    },
  });

  return {
    token,
    business: {
      ...membership.business,
      role: membership.role.name,
      isOwner: membership.isOwner,
    },
  };
}
