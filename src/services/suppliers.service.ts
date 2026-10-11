import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";
import { toDecimal } from "../utils/money";

type SupplierStatus = "ACTIVE" | "INACTIVE" | "ARCHIVED";

interface SupplierListOptions {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new AppError("Invalid text field", 400);
  }

  const normalized = value.trim();
  return normalized.length ? normalized : null;
}

function normalizeRequiredName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError("Supplier name is required", 400);
  }

  const name = value.trim().replace(/\s+/g, " ");

  if (name.length > 200) {
    throw new AppError("Supplier name cannot exceed 200 characters", 400);
  }

  return name;
}

function normalizeNonNegativeAmount(
  value: unknown,
  fieldName: string,
) {
  if (value === undefined || value === null || value === "") {
    return toDecimal(0);
  }

  const amount = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(amount) || amount < 0) {
    throw new AppError(`${fieldName} must be a valid non-negative amount`, 400);
  }

  return toDecimal(amount);
}

function normalizePaymentTerms(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const days = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(days) || days < 0 || days > 3650) {
    throw new AppError(
      "Payment terms must be a whole number between 0 and 3650",
      400,
    );
  }

  return days;
}

function normalizeStatus(status?: string): SupplierStatus | undefined {
  if (!status) return undefined;

  const normalized = status.toUpperCase();

  if (
    normalized !== "ACTIVE" &&
    normalized !== "INACTIVE" &&
    normalized !== "ARCHIVED"
  ) {
    throw new AppError("Invalid supplier status", 400);
  }

  return normalized;
}

function buildSupplierData(data: any) {
  return {
    name: normalizeRequiredName(data.name),
    businessName: normalizeOptionalString(data.businessName),
    phone: normalizeOptionalString(data.phone),
    email: normalizeOptionalString(data.email),
    address: normalizeOptionalString(data.address),
    city: normalizeOptionalString(data.city),
    state: normalizeOptionalString(data.state),
    pinCode: normalizeOptionalString(data.pinCode),
    gstin: normalizeOptionalString(data.gstin)?.toUpperCase() ?? null,
    pan: normalizeOptionalString(data.pan)?.toUpperCase() ?? null,
    paymentTerms: normalizePaymentTerms(data.paymentTerms),
    notes: normalizeOptionalString(data.notes),
  };
}

/**
 * List suppliers belonging to the authenticated business.
 * Payable is the current supplier balance; totalPurchase is
 * calculated from non-deleted purchase records.
 */
export async function listSuppliers(
  businessId: string,
  opts: SupplierListOptions = {},
) {
  const page = Math.max(1, Math.floor(opts.page || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit || 20)));
  const skip = (page - 1) * limit;
  const status = normalizeStatus(opts.status);
  const search = typeof opts.search === "string" ? opts.search.trim() : "";

  const where: any = {
    businessId,
    deletedAt: null,
    ...(status ? { status } : {}),
  };

  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { businessName: { contains: search, mode: "insensitive" } },
      { phone: { contains: search } },
      { email: { contains: search, mode: "insensitive" } },
      { gstin: { contains: search, mode: "insensitive" } },
    ];
  }

  const [suppliers, total] = await Promise.all([
    prisma.supplier.findMany({
      where,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip,
      take: limit,
    }),
    prisma.supplier.count({ where }),
  ]);

  const supplierIds = suppliers.map((supplier) => supplier.id);

  const purchaseTotals = supplierIds.length
    ? await prisma.purchase.groupBy({
        by: ["supplierId"],
        where: {
          businessId,
          supplierId: { in: supplierIds },
          deletedAt: null,
        },
        _sum: { grandTotal: true },
      })
    : [];

  const totalBySupplier = new Map(
    purchaseTotals.map((entry) => [
      entry.supplierId,
      Number(entry._sum.grandTotal ?? 0),
    ]),
  );

  return {
    data: suppliers.map((supplier) => ({
      ...supplier,
      payable: Number(supplier.currentBalance),
      totalPurchase: totalBySupplier.get(supplier.id) ?? 0,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Get one supplier and its recent purchase history.
 */
export async function getSupplier(businessId: string, id: string) {
  const supplier = await prisma.supplier.findFirst({
    where: {
      id,
      businessId,
      deletedAt: null,
    },
    include: {
      purchases: {
        where: { deletedAt: null },
        orderBy: { date: "desc" },
        take: 20,
        select: {
          id: true,
          billNumber: true,
          date: true,
          status: true,
          grandTotal: true,
          paidAmount: true,
          balanceAmount: true,
        },
      },
      paymentsOut: {
        orderBy: { date: "desc" },
        take: 20,
        select: {
          id: true,
          amount: true,
          date: true,
          paymentMethod: true,
          reference: true,
        },
      },
    },
  });

  if (!supplier) {
    throw new AppError("Supplier not found", 404);
  }

  const totalPurchase = supplier.purchases.reduce(
    (sum, purchase) => sum + Number(purchase.grandTotal),
    0,
  );

  return {
    ...supplier,
    payable: Number(supplier.currentBalance),
    totalPurchase,
  };
}

export async function createSupplier(
  businessId: string,
  data: any,
  userId?: string,
) {
  const supplierData = buildSupplierData(data);
  const openingBalance = normalizeNonNegativeAmount(
    data.openingBalance,
    "Opening balance",
  );

  const duplicate = await prisma.supplier.findFirst({
    where: {
      businessId,
      deletedAt: null,
      name: { equals: supplierData.name, mode: "insensitive" },
    },
    select: { id: true },
  });

  if (duplicate) {
    throw new AppError("A supplier with this name already exists", 409);
  }

  return prisma.$transaction(async (tx) => {
    const supplier = await tx.supplier.create({
      data: {
        businessId,
        ...supplierData,
        openingBalance: openingBalance as any,
        currentBalance: openingBalance as any,
      },
    });

    await tx.auditLog.create({
      data: {
        businessId,
        userId: userId || null,
        action: "CREATE",
        module: "suppliers",
        recordId: supplier.id,
        recordName: supplier.name,
        details: JSON.stringify({
          openingBalance: openingBalance.toString(),
        }),
      },
    });

    return supplier;
  }, { timeout: 10000 });
}

export async function updateSupplier(
  businessId: string,
  id: string,
  data: any,
  userId?: string,
) {
  const existing = await prisma.supplier.findFirst({
    where: { id, businessId, deletedAt: null },
  });

  if (!existing) {
    throw new AppError("Supplier not found", 404);
  }

  const updateData: Record<string, unknown> = {};

  const editableFields = [
    "name",
    "businessName",
    "phone",
    "email",
    "address",
    "city",
    "state",
    "pinCode",
    "gstin",
    "pan",
    "paymentTerms",
    "notes",
  ];

  if (editableFields.some((field) => data[field] !== undefined)) {
    const normalized = buildSupplierData({
      ...existing,
      ...data,
      name: data.name ?? existing.name,
    });

    for (const field of editableFields) {
      if (data[field] !== undefined) {
        updateData[field] = normalized[field as keyof typeof normalized];
      }
    }
  }

  // Opening balance is deliberately immutable after creation.
  // Use a dedicated accounting adjustment to preserve history.

  if (Object.keys(updateData).length === 0) {
    return existing;
  }

  return prisma.$transaction(async (tx) => {
    const current = await tx.supplier.findFirst({
      where: { id, businessId, deletedAt: null },
      select: { id: true, name: true },
    });

    if (!current) {
      throw new AppError("Supplier not found", 404);
    }

    if (updateData.name) {
      const duplicate = await tx.supplier.findFirst({
        where: {
          businessId,
          deletedAt: null,
          id: { not: id },
          name: {
            equals: String(updateData.name),
            mode: "insensitive",
          },
        },
        select: { id: true },
      });

      if (duplicate) {
        throw new AppError("A supplier with this name already exists", 409);
      }
    }

    const supplier = await tx.supplier.update({
      where: { id },
      data: updateData as any,
    });

    await tx.auditLog.create({
      data: {
        businessId,
        userId: userId || null,
        action: "UPDATE",
        module: "suppliers",
        recordId: id,
        recordName: supplier.name,
        details: JSON.stringify({ fields: Object.keys(updateData) }),
      },
    });

    return supplier;
  }, { timeout: 10000 });
}

export async function deleteSupplier(
  businessId: string,
  id: string,
  userId?: string,
) {
  const existing = await prisma.supplier.findFirst({
    where: { id, businessId, deletedAt: null },
  });

  if (!existing) {
    throw new AppError("Supplier not found", 404);
  }

  const hasPurchases = await prisma.purchase.count({
    where: { businessId, supplierId: id, deletedAt: null },
  });

  const hasPayments = await prisma.paymentOut.count({
    where: { businessId, supplierId: id },
  });

  if (hasPurchases > 0 || hasPayments > 0) {
    return prisma.$transaction(async (tx) => {
      const result = await tx.supplier.updateMany({
        where: { id, businessId, deletedAt: null },
        data: { deletedAt: new Date(), status: "ARCHIVED" },
      });

      if (result.count !== 1) {
        throw new AppError("Supplier was already archived", 409);
      }

      await tx.auditLog.create({
        data: {
          businessId,
          userId: userId || null,
          action: "DELETE",
          module: "suppliers",
          recordId: id,
          recordName: existing.name,
          details: JSON.stringify({ archived: true }),
        },
      });

      return { message: "Supplier archived successfully" };
    }, { timeout: 10000 });
  }

  return prisma.$transaction(async (tx) => {
    const result = await tx.supplier.updateMany({
      where: { id, businessId, deletedAt: null },
      data: { deletedAt: new Date(), status: "ARCHIVED" },
    });

    if (result.count !== 1) {
      throw new AppError("Supplier was already archived", 409);
    }

    await tx.auditLog.create({
      data: {
        businessId,
        userId: userId || null,
        action: "DELETE",
        module: "suppliers",
        recordId: id,
        recordName: existing.name,
        details: JSON.stringify({ archived: true }),
      },
    });

    return { message: "Supplier archived successfully" };
  }, { timeout: 10000 });
}
