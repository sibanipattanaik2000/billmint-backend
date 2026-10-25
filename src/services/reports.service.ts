import { InvoiceStatus, Prisma } from "@prisma/client";
import prisma from "../utils/prisma";

type ReportFilters = {
  from?: Date;
  to?: Date;
};

const EXCLUDED_INVOICE_STATUSES: InvoiceStatus[] = ["DRAFT", "CANCELLED"];

function dateFilter(filters: ReportFilters) {
  if (!filters.from && !filters.to) {
    return undefined;
  }

  return {
    ...(filters.from ? { gte: filters.from } : {}),
    ...(filters.to ? { lte: filters.to } : {}),
  };
}

function money(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function quantity(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function invoiceWhere(businessId: string, filters: ReportFilters) {
  return {
    businessId,
    deletedAt: null,
    status: {
      notIn: EXCLUDED_INVOICE_STATUSES,
    },
    ...(dateFilter(filters) ? { date: dateFilter(filters) } : {}),
  };
}

/**
 * Sales summary with invoice counts, tax breakdown,
 * outstanding balances and date-wise totals.
 */
export async function getSaleSummary(
  businessId: string,
  filters: ReportFilters = {},
) {
  const where = invoiceWhere(businessId, filters);

  const [aggregate, count, invoices] = await prisma.$transaction([
    prisma.sale.aggregate({
      where,
      _sum: {
        subtotal: true,
        discountAmount: true,
        taxableAmount: true,
        cgstAmount: true,
        sgstAmount: true,
        igstAmount: true,
        cessAmount: true,
        grandTotal: true,
        paidAmount: true,
        balanceAmount: true,
      },
    }),
    prisma.sale.count({ where }),
    prisma.sale.findMany({
      where,
      select: {
        id: true,
        invoiceNumber: true,
        date: true,
        status: true,
        grandTotal: true,
        paidAmount: true,
        balanceAmount: true,
      },
      orderBy: { date: "desc" },
      take: 5000,
    }),
  ]);

  const totals = aggregate._sum;

  const daily = new Map<
    string,
    { date: string; invoices: number; total: number }
  >();

  for (const invoice of invoices) {
    const date = invoice.date.toISOString().slice(0, 10);
    const current = daily.get(date) ?? {
      date,
      invoices: 0,
      total: 0,
    };

    current.invoices += 1;
    current.total += money(invoice.grandTotal);
    daily.set(date, current);
  }

  return {
    summary: {
      invoiceCount: count,
      subtotal: money(totals.subtotal),
      discountAmount: money(totals.discountAmount),
      taxableAmount: money(totals.taxableAmount),
      cgstAmount: money(totals.cgstAmount),
      sgstAmount: money(totals.sgstAmount),
      igstAmount: money(totals.igstAmount),
      cessAmount: money(totals.cessAmount),
      grandTotal: money(totals.grandTotal),
      paidAmount: money(totals.paidAmount),
      balanceAmount: money(totals.balanceAmount),
    },
    daily: Array.from(daily.values())
      .map((entry) => ({
        ...entry,
        total: roundMoney(entry.total),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** Sales grouped by customer, including walk-in sales. */
export async function getPartyWiseSales(
  businessId: string,
  filters: ReportFilters = {},
) {
  const sales = await prisma.sale.findMany({
    where: invoiceWhere(businessId, filters),
    select: {
      customerId: true,
      grandTotal: true,
      paidAmount: true,
      balanceAmount: true,
      customer: {
        select: { id: true, name: true, phone: true },
      },
    },
  });

  const grouped = new Map<
    string,
    {
      customerId: string | null;
      customerName: string;
      phone: string | null;
      invoiceCount: number;
      totalSales: number;
      paidAmount: number;
      balanceAmount: number;
    }
  >();

  for (const sale of sales) {
    const key = sale.customerId ?? "__walk_in__";
    const current = grouped.get(key) ?? {
      customerId: sale.customerId,
      customerName: sale.customer?.name ?? "Walk-in Customer",
      phone: sale.customer?.phone ?? null,
      invoiceCount: 0,
      totalSales: 0,
      paidAmount: 0,
      balanceAmount: 0,
    };

    current.invoiceCount += 1;
    current.totalSales += money(sale.grandTotal);
    current.paidAmount += money(sale.paidAmount);
    current.balanceAmount += money(sale.balanceAmount);
    grouped.set(key, current);
  }

  return Array.from(grouped.values())
    .map((entry) => ({
      ...entry,
      totalSales: roundMoney(entry.totalSales),
      paidAmount: roundMoney(entry.paidAmount),
      balanceAmount: roundMoney(entry.balanceAmount),
    }))
    .sort((a, b) => b.totalSales - a.totalSales);
}

/** Item-wise quantities and sales totals from completed invoices. */
export async function getItemWiseSales(
  businessId: string,
  filters: ReportFilters = {},
) {
  const items = await prisma.saleItem.findMany({
    where: {
      sale: invoiceWhere(businessId, filters),
    },
    select: {
      itemId: true,
      itemName: true,
      quantity: true,
      taxableAmount: true,
      amount: true,
      sale: {
        select: { date: true },
      },
    },
    take: 20000,
    orderBy: { sale: { date: "desc" } },
  });

  const grouped = new Map<
    string,
    {
      itemId: string | null;
      itemName: string;
      quantitySold: number;
      taxableAmount: number;
      salesAmount: number;
      lineCount: number;
    }
  >();

  for (const line of items) {
    const key = line.itemId ?? `name:${line.itemName}`;
    const current = grouped.get(key) ?? {
      itemId: line.itemId,
      itemName: line.itemName,
      quantitySold: 0,
      taxableAmount: 0,
      salesAmount: 0,
      lineCount: 0,
    };

    current.quantitySold += quantity(line.quantity);
    current.taxableAmount += money(line.taxableAmount);
    current.salesAmount += money(line.amount);
    current.lineCount += 1;
    grouped.set(key, current);
  }

  return Array.from(grouped.values())
    .map((entry) => ({
      ...entry,
      quantitySold: Number(entry.quantitySold.toFixed(3)),
      taxableAmount: roundMoney(entry.taxableAmount),
      salesAmount: roundMoney(entry.salesAmount),
    }))
    .sort((a, b) => b.salesAmount - a.salesAmount);
}

/** Purchase summary by supplier. */
export async function getPurchaseSummary(
  businessId: string,
  filters: ReportFilters = {},
) {
  const where = invoiceWhere(businessId, filters);

  const [aggregate, count, purchases] = await prisma.$transaction([
    prisma.purchase.aggregate({
      where,
      _sum: {
        subtotal: true,
        discountAmount: true,
        taxableAmount: true,
        cgstAmount: true,
        sgstAmount: true,
        igstAmount: true,
        grandTotal: true,
        paidAmount: true,
        balanceAmount: true,
      },
    }),
    prisma.purchase.count({ where }),
    prisma.purchase.findMany({
      where,
      select: {
        id: true,
        billNumber: true,
        date: true,
        grandTotal: true,
        paidAmount: true,
        balanceAmount: true,
        supplier: {
          select: { id: true, name: true },
        },
      },
      orderBy: { date: "desc" },
      take: 5000,
    }),
  ]);

  const totals = aggregate._sum;
  const suppliers = new Map<
    string,
    {
      supplierId: string | null;
      supplierName: string;
      invoiceCount: number;
      purchaseAmount: number;
      paidAmount: number;
      balanceAmount: number;
    }
  >();

  for (const purchase of purchases) {
    const key = purchase.supplier?.id ?? "__unspecified__";
    const current = suppliers.get(key) ?? {
      supplierId: purchase.supplier?.id ?? null,
      supplierName: purchase.supplier?.name ?? "Unspecified Supplier",
      invoiceCount: 0,
      purchaseAmount: 0,
      paidAmount: 0,
      balanceAmount: 0,
    };

    current.invoiceCount += 1;
    current.purchaseAmount += money(purchase.grandTotal);
    current.paidAmount += money(purchase.paidAmount);
    current.balanceAmount += money(purchase.balanceAmount);
    suppliers.set(key, current);
  }

  return {
    summary: {
      invoiceCount: count,
      subtotal: money(totals.subtotal),
      discountAmount: money(totals.discountAmount),
      taxableAmount: money(totals.taxableAmount),
      cgstAmount: money(totals.cgstAmount),
      sgstAmount: money(totals.sgstAmount),
      igstAmount: money(totals.igstAmount),
      grandTotal: money(totals.grandTotal),
      paidAmount: money(totals.paidAmount),
      balanceAmount: money(totals.balanceAmount),
    },
    suppliers: Array.from(suppliers.values())
      .map((entry) => ({
        ...entry,
        purchaseAmount: roundMoney(entry.purchaseAmount),
        paidAmount: roundMoney(entry.paidAmount),
        balanceAmount: roundMoney(entry.balanceAmount),
      }))
      .sort((a, b) => b.purchaseAmount - a.purchaseAmount),
  };
}

/** Current inventory quantities and estimated stock values. */
export async function getStockSummary(businessId: string) {
  const items = await prisma.item.findMany({
    where: {
      businessId,
      deletedAt: null,
      status: "ACTIVE",
    },
    select: {
      id: true,
      name: true,
      sku: true,
      currentStock: true,
      minimumStock: true,
      purchasePrice: true,
      salePrice: true,
      category: { select: { id: true, name: true } },
      unit: { select: { shortName: true } },
    },
    orderBy: { name: "asc" },
  });

  const data = items.map((item) => {
    const stock = quantity(item.currentStock);
    const purchasePrice = money(item.purchasePrice);
    const salePrice = money(item.salePrice);

    return {
      id: item.id,
      name: item.name,
      sku: item.sku,
      category: item.category?.name ?? null,
      unit: item.unit?.shortName ?? null,
      currentStock: stock,
      minimumStock: quantity(item.minimumStock),
      purchasePrice,
      salePrice,
      stockCostValue: roundMoney(stock * purchasePrice),
      stockSaleValue: roundMoney(stock * salePrice),
    };
  });

  return {
    summary: {
      itemCount: data.length,
      totalUnits: Number(
        data.reduce((sum, item) => sum + item.currentStock, 0).toFixed(3),
      ),
      stockCostValue: roundMoney(
        data.reduce((sum, item) => sum + item.stockCostValue, 0),
      ),
      stockSaleValue: roundMoney(
        data.reduce((sum, item) => sum + item.stockSaleValue, 0),
      ),
      lowStockCount: data.filter(
        (item) => item.currentStock <= item.minimumStock,
      ).length,
    },
    data,
  };
}

/** Items at or below their configured minimum stock level. */
export async function getLowStockReport(businessId: string) {
  const items = await prisma.item.findMany({
    where: {
      businessId,
      deletedAt: null,
      status: "ACTIVE",
    },
    select: {
      id: true,
      name: true,
      sku: true,
      currentStock: true,
      minimumStock: true,
      purchasePrice: true,
      category: { select: { name: true } },
      unit: { select: { shortName: true } },
    },
    orderBy: { name: "asc" },
  });

  return items
    .filter(
      (item) => quantity(item.currentStock) <= quantity(item.minimumStock),
    )
    .map((item) => ({
      id: item.id,
      name: item.name,
      sku: item.sku,
      category: item.category?.name ?? null,
      unit: item.unit?.shortName ?? null,
      currentStock: quantity(item.currentStock),
      minimumStock: quantity(item.minimumStock),
      shortage: Number(
        Math.max(
          0,
          quantity(item.minimumStock) - quantity(item.currentStock),
        ).toFixed(3),
      ),
      stockCostValue: roundMoney(
        quantity(item.currentStock) * money(item.purchasePrice),
      ),
    }));
}

/** Outstanding customer balances. */
export async function getReceivableReport(
  businessId: string,
  filters: ReportFilters = {},
) {
  const data = await prisma.sale.findMany({
    where: {
      ...invoiceWhere(businessId, filters),
      balanceAmount: { gt: 0 },
    },
    select: {
      id: true,
      invoiceNumber: true,
      date: true,
      dueDate: true,
      grandTotal: true,
      paidAmount: true,
      balanceAmount: true,
      customer: { select: { id: true, name: true, phone: true } },
    },
    orderBy: [{ dueDate: "asc" }, { date: "asc" }],
    take: 10000,
  });

  return {
    summary: {
      invoiceCount: data.length,
      outstandingAmount: roundMoney(
        data.reduce((sum, sale) => sum + money(sale.balanceAmount), 0),
      ),
    },
    data,
  };
}

/** Outstanding supplier balances. */
export async function getPayableReport(
  businessId: string,
  filters: ReportFilters = {},
) {
  const data = await prisma.purchase.findMany({
    where: {
      ...invoiceWhere(businessId, filters),
      balanceAmount: { gt: 0 },
    },
    select: {
      id: true,
      billNumber: true,
      date: true,
      dueDate: true,
      grandTotal: true,
      paidAmount: true,
      balanceAmount: true,
      supplier: { select: { id: true, name: true, phone: true } },
    },
    orderBy: [{ dueDate: "asc" }, { date: "asc" }],
    take: 10000,
  });

  return {
    summary: {
      invoiceCount: data.length,
      outstandingAmount: roundMoney(
        data.reduce((sum, purchase) => sum + money(purchase.balanceAmount), 0),
      ),
    },
    data,
  };
}

/** Expense report with category-wise totals. */
export async function getExpenseReport(
  businessId: string,
  filters: ReportFilters = {},
) {
  const data = await prisma.expense.findMany({
    where: {
      businessId,
      ...(dateFilter(filters) ? { date: dateFilter(filters) } : {}),
    },
    select: {
      id: true,
      date: true,
      amount: true,
      description: true,
      paymentMethod: true,
      category: { select: { id: true, name: true } },
    },
    orderBy: { date: "desc" },
    take: 10000,
  });

  const categories = new Map<
    string,
    {
      categoryId: string | null;
      categoryName: string;
      total: number;
      count: number;
    }
  >();

  for (const expense of data) {
    const key = expense.category?.id ?? "__uncategorized__";
    const current = categories.get(key) ?? {
      categoryId: expense.category?.id ?? null,
      categoryName: expense.category?.name ?? "Uncategorized",
      total: 0,
      count: 0,
    };

    current.total += money(expense.amount);
    current.count += 1;
    categories.set(key, current);
  }

  return {
    summary: {
      expenseCount: data.length,
      totalAmount: roundMoney(
        data.reduce((sum, expense) => sum + money(expense.amount), 0),
      ),
    },
    categories: Array.from(categories.values())
      .map((entry) => ({ ...entry, total: roundMoney(entry.total) }))
      .sort((a, b) => b.total - a.total),
    data,
  };
}
/**
 * Daily collections from customer receipts and separately recorded
 * Other Income. Amounts are counted once per receipt, not once per invoice.
 */
export async function getPaymentCollectionReport(
  businessId: string,
  filters: ReportFilters = {},
) {
  const range = dateFilter(filters);

  const [payments, otherIncomes] = await Promise.all([
    prisma.paymentIn.findMany({
      where: {
        businessId,
        ...(range ? { date: range } : {}),
      },
      select: {
        id: true,
        date: true,
        amount: true,
        paymentMethod: true,
        reference: true,
        notes: true,
        customer: {
          select: { name: true },
        },
        bankAccount: {
          select: { name: true },
        },
        allocations: {
          select: {
            sale: {
              select: { invoiceNumber: true },
            },
          },
        },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 20000,
    }),

    prisma.otherIncome.findMany({
      where: {
        businessId,
        ...(range ? { date: range } : {}),
      },
      select: {
        id: true,
        date: true,
        amount: true,
        paymentMethod: true,
        reference: true,
        notes: true,
        description: true,
        category: true,
        bankAccount: {
          select: { name: true },
        },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 20000,
    }),
  ]);

  type CollectionMethod = "Cash" | "UPI" | "Card" | "Bank" | "Other";

  function classifyMethod(value: string | null | undefined): CollectionMethod {
    const method = String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ");

    if (/\bcash\b/.test(method)) {
      return "Cash";
    }

    if (
      /\bupi\b/.test(method) ||
      method.includes("google pay") ||
      method.includes("googlepay") ||
      method.includes("gpay") ||
      method.includes("phonepe") ||
      method.includes("paytm") ||
      method.includes("bhim") ||
      method.includes("amazon pay")
    ) {
      return "UPI";
    }

    if (
      /\bcard\b/.test(method) ||
      method.includes("visa") ||
      method.includes("mastercard") ||
      method.includes("debit card") ||
      method.includes("credit card") ||
      method.includes("rupay card")
    ) {
      return "Card";
    }

    if (
      method.includes("bank") ||
      method.includes("transfer") ||
      method.includes("net banking") ||
      method.includes("netbanking") ||
      /\bneft\b/.test(method) ||
      /\brtgs\b/.test(method) ||
      /\bimps\b/.test(method)
    ) {
      return "Bank";
    }

    return "Other";
  }

  const rows = [
    ...payments.map((payment) => ({
      id: payment.id,
      date: payment.date,
      source: "Customer Payment",
      partyOrCategory: payment.customer?.name ?? "Walk-in / Unspecified",
      invoiceNumbers:
        payment.allocations
          .map((allocation) => allocation.sale.invoiceNumber)
          .filter(Boolean)
          .join(", ") || "—",
      paymentMethod: payment.paymentMethod,
      method: classifyMethod(payment.paymentMethod),
      bankAccountName: payment.bankAccount?.name ?? "",
      reference: payment.reference ?? "",
      description: payment.notes ?? "Customer receipt",
      amount: money(payment.amount),
    })),

    ...otherIncomes.map((income) => ({
      id: income.id,
      date: income.date,
      source: "Other Income",
      partyOrCategory:
        income.category?.trim() || income.description?.trim() || "Other Income",
      invoiceNumbers: "—",
      paymentMethod: income.paymentMethod ?? "Other",
      method: classifyMethod(income.paymentMethod),
      bankAccountName: income.bankAccount?.name ?? "",
      reference: income.reference ?? "",
      description: income.description ?? income.notes ?? "Other income receipt",
      amount: money(income.amount),
    })),
  ].sort((a, b) => {
    const dateDifference =
      new Date(b.date).getTime() - new Date(a.date).getTime();

    return dateDifference || a.id.localeCompare(b.id);
  });

  const totals = {
    cash: 0,
    upi: 0,
    card: 0,
    bank: 0,
    other: 0,
    total: 0,
  };

  for (const row of rows) {
    if (row.method === "Cash") totals.cash += row.amount;
    else if (row.method === "UPI") totals.upi += row.amount;
    else if (row.method === "Card") totals.card += row.amount;
    else if (row.method === "Bank") totals.bank += row.amount;
    else totals.other += row.amount;

    totals.total += row.amount;
  }

  return {
    summary: {
      cash: roundMoney(totals.cash),
      upi: roundMoney(totals.upi),
      card: roundMoney(totals.card),
      bank: roundMoney(totals.bank),
      other: roundMoney(totals.other),
      total: roundMoney(totals.total),
      paymentCount: rows.length,
      customerPaymentCount: payments.length,
      otherIncomeCount: otherIncomes.length,
    },
    data: rows.map((row) => ({
      ...row,
      amount: roundMoney(row.amount),
    })),
  };
}
