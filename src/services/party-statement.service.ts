import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";

export interface PartyStatementFilters {
  from?: Date;
  to?: Date;
}

type StatementEntry = {
  date: Date;
  type: string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
};

function amount(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function dateFilter(filters: PartyStatementFilters) {
  return {
    ...(filters.from ? { gte: filters.from } : {}),
    ...(filters.to ? { lte: filters.to } : {}),
  };
}

function buildStatement(
  openingBalance: number,
  entries: StatementEntry[],
  filters: PartyStatementFilters,
) {
  entries.sort((a, b) => {
    const dateDifference = a.date.getTime() - b.date.getTime();
    return dateDifference || a.reference.localeCompare(b.reference);
  });

  let balance = openingBalance;

  const openingEntries = filters.from
    ? entries.filter((entry) => entry.date < filters.from!)
    : [];

  for (const entry of openingEntries) {
    balance += entry.debit - entry.credit;
  }

  const visibleEntries = entries.filter(
    (entry) =>
      (!filters.from || entry.date >= filters.from) &&
      (!filters.to || entry.date <= filters.to),
  );

  const openingAtStart = round(balance);

  const transactions = visibleEntries.map((entry) => {
    balance += entry.debit - entry.credit;

    return {
      ...entry,
      debit: round(entry.debit),
      credit: round(entry.credit),
      balance: round(balance),
    };
  });

  return {
    openingBalance: openingAtStart,
    transactions,
    closingBalance: round(balance),
    totals: {
      debit: round(
        visibleEntries.reduce((total, entry) => total + entry.debit, 0),
      ),
      credit: round(
        visibleEntries.reduce((total, entry) => total + entry.credit, 0),
      ),
      transactionCount: visibleEntries.length,
    },
    period: {
      from: filters.from ?? null,
      to: filters.to ?? null,
    },
  };
}

export async function getCustomerStatement(
  businessId: string,
  customerId: string,
  filters: PartyStatementFilters = {},
) {
  if (!businessId) {
    throw new AppError("Business context is required", 400);
  }

  if (!customerId) {
    throw new AppError("Customer ID is required", 400);
  }

  const customer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      businessId,
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      phone: true,
      gstin: true,
      openingBalance: true,
    },
  });

  if (!customer) {
    throw new AppError("Customer not found", 404);
  }

  const [sales, payments] = await Promise.all([
    prisma.sale.findMany({
      where: {
        businessId,
        customerId,
        deletedAt: null,
        status: { notIn: ["DRAFT", "CANCELLED"] },
        ...(filters.to ? { date: { lte: filters.to } } : {}),
      },
      select: {
        date: true,
        invoiceNumber: true,
        grandTotal: true,
      },
      orderBy: { date: "asc" },
      take: 20000,
    }),
    prisma.paymentIn.findMany({
      where: {
        businessId,
        customerId,
        ...(filters.to ? { date: { lte: filters.to } } : {}),
      },
      select: {
        date: true,
        amount: true,
        reference: true,
        paymentMethod: true,
        id: true,
      },
      orderBy: { date: "asc" },
      take: 20000,
    }),
  ]);

  const entries: StatementEntry[] = [
    ...sales.map((sale) => ({
      date: sale.date,
      type: "SALE",
      reference: sale.invoiceNumber,
      description: "Sales invoice",
      debit: amount(sale.grandTotal),
      credit: 0,
    })),
    ...payments.map((payment) => ({
      date: payment.date,
      type: "PAYMENT_IN",
      reference: payment.reference?.trim() || payment.id,
      description: `Customer payment (${payment.paymentMethod})`,
      debit: 0,
      credit: amount(payment.amount),
    })),
  ];

  return {
    partyType: "CUSTOMER",
    party: customer,
    ...buildStatement(amount(customer.openingBalance), entries, filters),
    limits: {
      salesTruncated: sales.length === 20000,
      paymentsTruncated: payments.length === 20000,
    },
  };
}

export async function getSupplierStatement(
  businessId: string,
  supplierId: string,
  filters: PartyStatementFilters = {},
) {
  if (!businessId) {
    throw new AppError("Business context is required", 400);
  }

  if (!supplierId) {
    throw new AppError("Supplier ID is required", 400);
  }

  const supplier = await prisma.supplier.findFirst({
    where: {
      id: supplierId,
      businessId,
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      phone: true,
      gstin: true,
      openingBalance: true,
    },
  });

  if (!supplier) {
    throw new AppError("Supplier not found", 404);
  }

  const [purchases, payments] = await Promise.all([
    prisma.purchase.findMany({
      where: {
        businessId,
        supplierId,
        deletedAt: null,
        status: { notIn: ["DRAFT", "CANCELLED"] },
        ...(filters.to ? { date: { lte: filters.to } } : {}),
      },
      select: {
        date: true,
        billNumber: true,
        grandTotal: true,
      },
      orderBy: { date: "asc" },
      take: 20000,
    }),
    prisma.paymentOut.findMany({
      where: {
        businessId,
        supplierId,
        ...(filters.to ? { date: { lte: filters.to } } : {}),
      },
      select: {
        date: true,
        amount: true,
        reference: true,
        paymentMethod: true,
        id: true,
      },
      orderBy: { date: "asc" },
      take: 20000,
    }),
  ]);

  const entries: StatementEntry[] = [
    ...purchases.map((purchase) => ({
      date: purchase.date,
      type: "PURCHASE",
      reference: purchase.billNumber,
      description: "Purchase invoice",
      debit: 0,
      credit: amount(purchase.grandTotal),
    })),
    ...payments.map((payment) => ({
      date: payment.date,
      type: "PAYMENT_OUT",
      reference: payment.reference?.trim() || payment.id,
      description: `Supplier payment (${payment.paymentMethod})`,
      debit: amount(payment.amount),
      credit: 0,
    })),
  ];

  return {
    partyType: "SUPPLIER",
    party: supplier,
    ...buildStatement(amount(supplier.openingBalance), entries, filters),
    limits: {
      purchasesTruncated: purchases.length === 20000,
      paymentsTruncated: payments.length === 20000,
    },
  };
}