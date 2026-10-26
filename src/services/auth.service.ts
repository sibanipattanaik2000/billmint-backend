import prisma from "../utils/prisma";
import {
  hashPassword,
  verifyPassword,
  signToken,
  JwtPayload,
} from "../utils/auth";
import { AppError } from "../middleware/errorHandler";
import { toDecimal } from "../utils/money";

const DEFAULT_PERMISSIONS = [
  { code: "dashboard.view", name: "View Dashboard", module: "dashboard" },
  { code: "sales.view", name: "View Sales", module: "sales" },
  { code: "sales.create", name: "Create Sales", module: "sales" },
  { code: "sales.edit", name: "Edit Sales", module: "sales" },
  { code: "sales.delete", name: "Delete Sales", module: "sales" },
  { code: "purchases.view", name: "View Purchases", module: "purchases" },
  { code: "purchases.create", name: "Create Purchases", module: "purchases" },
  { code: "purchases.edit", name: "Edit Purchases", module: "purchases" },
  { code: "purchases.delete", name: "Delete Purchases", module: "purchases" },
  { code: "customers.view", name: "View Customers", module: "customers" },
  { code: "customers.create", name: "Create Customers", module: "customers" },
  { code: "customers.edit", name: "Edit Customers", module: "customers" },
  { code: "customers.delete", name: "Delete Customers", module: "customers" },
  { code: "suppliers.view", name: "View Suppliers", module: "suppliers" },
  { code: "suppliers.create", name: "Create Suppliers", module: "suppliers" },
  { code: "suppliers.edit", name: "Edit Suppliers", module: "suppliers" },
  { code: "suppliers.delete", name: "Delete Suppliers", module: "suppliers" },
  { code: "items.view", name: "View Items", module: "items" },
  { code: "items.create", name: "Create Items", module: "items" },
  { code: "items.edit", name: "Edit Items", module: "items" },
  { code: "items.delete", name: "Delete Items", module: "items" },
  { code: "inventory.view", name: "View Inventory", module: "inventory" },
  { code: "inventory.adjust", name: "Adjust Stock", module: "inventory" },
  { code: "expenses.view", name: "View Expenses", module: "expenses" },
  { code: "expenses.create", name: "Create Expenses", module: "expenses" },
  { code: "payments.view", name: "View Payments", module: "payments" },
  { code: "payments.create", name: "Create Payments", module: "payments" },
  { code: "reports.view", name: "View Reports", module: "reports" },
  { code: "gst.view", name: "View GST", module: "gst" },
  { code: "settings.view", name: "View Settings", module: "settings" },
  { code: "settings.edit", name: "Edit Settings", module: "settings" },
  { code: "users.view", name: "View Users", module: "users" },
  { code: "users.manage", name: "Manage Users", module: "users" },
  { code: "import.use", name: "Import Data", module: "import" },
  { code: "export.use", name: "Export Data", module: "export" },
];

const DEFAULT_EXPENSE_CATEGORIES = [
  "Rent",
  "Salary",
  "Electricity",
  "Transport",
  "Internet",
  "Marketing",
  "Office",
  "Maintenance",
  "Other",
];

export async function registerBusiness(data: {
  businessName: string;
  ownerName: string;
  userId: string;
  password: string;
  email?: string;
  phone?: string;
  businessType?: string;
  address?: string;
  city?: string;
  state?: string;
  pinCode?: string;
  country?: string;
  gstin?: string;
  pan?: string;
}) {
  // Check unique userId
  const existing = await prisma.user.findUnique({
    where: { userId: data.userId },
  });
  if (existing) {
    throw new AppError("User ID already taken", 409);
  }

  const passwordHash = await hashPassword(data.password);

  const result = await prisma.$transaction(
    async (tx) => {
      // Ensure permissions exist
      // Ensure all default permissions exist once.
      await tx.permission.createMany({
        data: DEFAULT_PERMISSIONS,
        skipDuplicates: true,
      });

      const allPerms = await tx.permission.findMany();
      // Create user
      const user = await tx.user.create({
        data: {
          userId: data.userId,
          passwordHash,
          name: data.ownerName,
          email: data.email || null,
          phone: data.phone || null,
        },
      });

      // Create business
      const business = await tx.business.create({
        data: {
          name: data.businessName,
          ownerName: data.ownerName,
          email: data.email || null,
          phone: data.phone || null,
          gstin: data.gstin || null,
          pan: data.pan || null,
          address: data.address || null,
          city: data.city || null,
          state: data.state || null,
          pinCode: data.pinCode || null,
          country: data.country || "India",
          businessType: data.businessType || null,
          setupCompleted: false,
        },
      });

      // Create Owner role with all permissions
      const ownerRole = await tx.role.create({
        data: {
          businessId: business.id,
          name: "Owner",
          isSystem: true,
          permissions: {
            create: allPerms.map((p) => ({ permissionId: p.id })),
          },
        },
      });

      // Create Admin, Manager, Staff roles
      await tx.role.create({
        data: {
          businessId: business.id,
          name: "Admin",
          isSystem: true,
          permissions: {
            create: allPerms
              .filter((p) => !p.code.startsWith("users."))
              .map((p) => ({ permissionId: p.id })),
          },
        },
      });

      await tx.role.create({
        data: {
          businessId: business.id,
          name: "Manager",
          isSystem: true,
          permissions: {
            create: allPerms
              .filter((p) =>
                [
                  "dashboard",
                  "sales",
                  "purchases",
                  "customers",
                  "suppliers",
                  "items",
                  "inventory",
                  "expenses",
                  "payments",
                  "reports",
                ].some((m) => p.module === m),
              )
              .map((p) => ({ permissionId: p.id })),
          },
        },
      });

      await tx.role.create({
        data: {
          businessId: business.id,
          name: "Staff",
          isSystem: true,
          permissions: {
            create: allPerms
              .filter((p) =>
                [
                  "dashboard.view",
                  "sales.view",
                  "sales.create",
                  "customers.view",
                  "items.view",
                  "payments.create",
                ].includes(p.code),
              )
              .map((p) => ({ permissionId: p.id })),
          },
        },
      });

      // Membership
      const member = await tx.businessMember.create({
        data: {
          businessId: business.id,
          userId: user.id,
          roleId: ownerRole.id,
          isOwner: true,
        },
      });

      // Settings
      await tx.businessSettings.create({
        data: { businessId: business.id },
      });

      // Invoice sequences
      for (const type of [
        "invoice",
        "quotation",
        "challan",
        "purchase",
        "sale_return",
        "purchase_return",
      ]) {
        const prefixes: Record<string, string> = {
          invoice: "INV",
          quotation: "QT",
          challan: "DC",
          purchase: "PUR",
          sale_return: "SR",
          purchase_return: "PR",
        };
        await tx.invoiceSequence.create({
          data: {
            businessId: business.id,
            type,
            prefix: prefixes[type],
            nextNumber: 1,
          },
        });
      }

      // Default units
      for (const [name, short] of [
        ["Piece", "Pcs"],
        ["Kilogram", "Kg"],
        ["Litre", "L"],
        ["Meter", "M"],
        ["Box", "Box"],
        ["Dozen", "Dzn"],
      ]) {
        await tx.unit.create({
          data: { businessId: business.id, name, shortName: short },
        });
      }

      // Expense categories
      for (const name of DEFAULT_EXPENSE_CATEGORIES) {
        await tx.expenseCategory.create({
          data: { businessId: business.id, name, isSystem: true },
        });
      }

      // Cash account
      await tx.bankAccount.create({
        data: {
          businessId: business.id,
          name: "Cash",
          isCash: true,
          openingBalance: toDecimal(0) as any,
          currentBalance: toDecimal(0) as any,
        },
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          businessId: business.id,
          userId: user.id,
          action: "REGISTER",
          module: "auth",
          recordId: business.id,
          recordName: business.name,
          details: JSON.stringify({ userId: data.userId }),
        },
      });

      return { user, business, member, role: ownerRole };
    },
    {
      timeout: 15000,
    },
  );

  const tokenPayload: JwtPayload = {
    userId: result.user.id,
    businessId: result.business.id,
    memberId: result.member.id,
    role: result.role.name,
    isOwner: true,
  };

  const token = signToken(tokenPayload);

  return {
    token,
    user: {
      id: result.user.id,
      userId: result.user.userId,
      name: result.user.name,
      email: result.user.email,
    },
    business: {
      id: result.business.id,
      name: result.business.name,
      setupCompleted: result.business.setupCompleted,
    },
  };
}

export async function loginUser(
  userId: string,
  password: string,
  storeCode: string,
  ip?: string,
) {
  const user = await prisma.user.findUnique({
    where: { userId },
    include: {
      memberships: {
        where: { status: "ACTIVE" },
        include: {
          business: true,
          role: true,
        },
        orderBy: { joinedAt: "asc" },
      },
    },
  });

  if (!user || user.deletedAt) {
    throw new AppError("Invalid User ID or password", 401);
  }

  // Account lock check
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
    throw new AppError(`Account locked. Try again in ${mins} minute(s)`, 423);
  }

  if (user.status !== "ACTIVE") {
    throw new AppError("Account is inactive", 403);
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    const failedLogins = user.failedLogins + 1;
    const updates: any = { failedLogins };
    if (failedLogins >= 5) {
      updates.lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 min
      updates.failedLogins = 0;
    }
    await prisma.user.update({ where: { id: user.id }, data: updates });
    throw new AppError("Invalid User ID or password", 401);
  }

  if (user.memberships.length === 0) {
    throw new AppError("No active business membership found", 403);
  }

  const membership = user.memberships.find(
    (entry) =>
      entry.business.storeCode.toUpperCase() === storeCode.toUpperCase(),
  );

  if (!membership) {
    throw new AppError("Invalid Store Code or credentials", 401);
  }

  // Reset failed logins
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  //const membership = user.memberships[0];

  const tokenPayload: JwtPayload = {
    userId: user.id,
    businessId: membership.businessId,
    memberId: membership.id,
    role: membership.role.name,
    isOwner: membership.isOwner,
  };

  const token = signToken(tokenPayload);

  // Audit
  await prisma.auditLog.create({
    data: {
      businessId: membership.businessId,
      userId: user.id,
      action: "LOGIN",
      module: "auth",
      ipAddress: ip || null,
    },
  });

  return {
    token,
    user: {
      id: user.id,
      userId: user.userId,
      name: user.name,
      email: user.email,
    },
    business: {
      id: membership.business.id,
      name: membership.business.name,
      setupCompleted: membership.business.setupCompleted,
      state: membership.business.state,
      gstin: membership.business.gstin,
      storeCode: true,
    },
    role: membership.role.name,
    isOwner: membership.isOwner,
  };
}

export async function getMe(userId: string, businessId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      userId: true,
      name: true,
      email: true,
      phone: true,
      lastLoginAt: true,
    },
  });

  if (!user) throw new AppError("User not found", 404);

  const member = await prisma.businessMember.findFirst({
    where: { userId, businessId, status: "ACTIVE" },
    include: {
      role: {
        include: {
          permissions: { include: { permission: true } },
        },
      },
      business: {
        select: {
          id: true,
          name: true,
          ownerName: true,
          email: true,
          phone: true,
          gstin: true,
          pan: true,
          address: true,
          city: true,
          state: true,
          pinCode: true,
          logoUrl: true,
          setupCompleted: true,
          businessType: true,
        },
      },
    },
  });

  if (!member) throw new AppError("Membership not found", 404);

  const settings = await prisma.businessSettings.findUnique({
    where: { businessId },
  });

  return {
    user,
    business: member.business,
    role: member.role.name,
    isOwner: member.isOwner,
    permissions: member.role.permissions.map((rp) => rp.permission.code),
    settings,
  };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError("User not found", 404);

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) throw new AppError("Current password is incorrect", 400);

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });

  return { message: "Password changed successfully" };
}
