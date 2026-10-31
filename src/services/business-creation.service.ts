
import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";
import { JwtPayload, signToken } from "../utils/auth";
import { toDecimal } from "../utils/money";

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

type CreateBusinessInput = {
  businessName: string;
  businessType?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  pinCode?: string;
  country?: string;
  gstin?: string;
  pan?: string;
};

export async function createBusinessForUser(
  userId: string,
  data: CreateBusinessInput,
) {
  const businessName = data.businessName?.trim();

  if (!businessName) {
    throw new AppError("Company name is required", 400);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      userId: true,
      name: true,
      email: true,
      deletedAt: true,
      status: true,
    },
  });

  if (!user || user.deletedAt || user.status !== "ACTIVE") {
    throw new AppError("Active user account not found", 403);
  }

  const result = await prisma.$transaction(
    async (tx) => {
      const allPermissions = await tx.permission.findMany();

      if (allPermissions.length === 0) {
        throw new AppError(
          "System permissions are not configured",
          500,
        );
      }

      const business = await tx.business.create({
        data: {
          name: businessName,
          ownerName: user.name,
          email: data.email?.trim() || user.email || null,
          phone: data.phone?.trim() || null,
          businessType: data.businessType?.trim() || null,
          address: data.address?.trim() || null,
          city: data.city?.trim() || null,
          state: data.state?.trim() || null,
          pinCode: data.pinCode?.trim() || null,
          country: data.country?.trim() || "India",
          gstin: data.gstin?.trim() || null,
          pan: data.pan?.trim() || null,
          setupCompleted: false,
        },
      });

      const ownerRole = await tx.role.create({
        data: {
          businessId: business.id,
          name: "Owner",
          isSystem: true,
          permissions: {
            create: allPermissions.map((permission) => ({
              permissionId: permission.id,
            })),
          },
        },
      });

      await tx.role.create({
        data: {
          businessId: business.id,
          name: "Admin",
          isSystem: true,
          permissions: {
            create: allPermissions
              .filter((permission) => !permission.code.startsWith("users."))
              .map((permission) => ({
                permissionId: permission.id,
              })),
          },
        },
      });

      await tx.role.create({
        data: {
          businessId: business.id,
          name: "Manager",
          isSystem: true,
          permissions: {
            create: allPermissions
              .filter((permission) =>
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
                ].includes(permission.module),
              )
              .map((permission) => ({
                permissionId: permission.id,
              })),
          },
        },
      });

      await tx.role.create({
        data: {
          businessId: business.id,
          name: "Staff",
          isSystem: true,
          permissions: {
            create: allPermissions
              .filter((permission) =>
                [
                  "dashboard.view",
                  "sales.view",
                  "sales.create",
                  "customers.view",
                  "items.view",
                  "payments.create",
                ].includes(permission.code),
              )
              .map((permission) => ({
                permissionId: permission.id,
              })),
          },
        },
      });

      const member = await tx.businessMember.create({
        data: {
          businessId: business.id,
          userId: user.id,
          roleId: ownerRole.id,
          isOwner: true,
        },
      });

      await tx.businessSettings.create({
        data: {
          businessId: business.id,
        },
      });

      const prefixes: Record<string, string> = {
        invoice: "INV",
        quotation: "QT",
        challan: "DC",
        purchase: "PUR",
        sale_return: "SR",
        purchase_return: "PR",
      };

      for (const [type, prefix] of Object.entries(prefixes)) {
        await tx.invoiceSequence.create({
          data: {
            businessId: business.id,
            type,
            prefix,
            nextNumber: 1,
          },
        });
      }

      const defaultUnits = [
        ["Piece", "Pcs"],
        ["Kilogram", "Kg"],
        ["Litre", "L"],
        ["Meter", "M"],
        ["Box", "Box"],
        ["Dozen", "Dzn"],
      ];

      for (const [name, shortName] of defaultUnits) {
        await tx.unit.create({
          data: {
            businessId: business.id,
            name,
            shortName,
          },
        });
      }

      for (const name of DEFAULT_EXPENSE_CATEGORIES) {
        await tx.expenseCategory.create({
          data: {
            businessId: business.id,
            name,
            isSystem: true,
          },
        });
      }

      await tx.bankAccount.create({
        data: {
          businessId: business.id,
          name: "Cash",
          isCash: true,
          openingBalance: toDecimal(0) as any,
          currentBalance: toDecimal(0) as any,
        },
      });

      await tx.auditLog.create({
        data: {
          businessId: business.id,
          userId: user.id,
          action: "CREATE_COMPANY",
          module: "business",
          recordId: business.id,
          recordName: business.name,
          details: JSON.stringify({
            createdBy: user.userId,
          }),
        },
      });

      return {
        business,
        member,
        role: ownerRole,
      };
    },
    {
      timeout: 20000,
    },
  );

  const tokenPayload: JwtPayload = {
    userId: user.id,
    businessId: result.business.id,
    memberId: result.member.id,
    role: result.role.name,
    isOwner: true,
  };

  return {
    token: signToken(tokenPayload),
    business: {
      id: result.business.id,
      name: result.business.name,
      storeCode: result.business.storeCode,
      setupCompleted: result.business.setupCompleted,
      role: result.role.name,
      isOwner: true,
    },
  };
}
