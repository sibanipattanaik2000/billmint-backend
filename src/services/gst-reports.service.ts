import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";

export interface GstReportFilters {
  from?: Date;
  to?: Date;
}

function dateWhere(filters: GstReportFilters) {
  if (!filters.from && !filters.to) return {};

  return {
    date: {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    },
  };
}

function money(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function addTaxRow(
  rows: Map<number, {
    gstRate: number;
    taxableAmount: number;
    cgstAmount: number;
    sgstAmount: number;
    igstAmount: number;
    cessAmount: number;
    invoiceCount: number;
  }>,
  rate: number,
  taxable: number,
  cgst: number,
  sgst: number,
  igst: number,
  invoiceCount = 0,
) {
  const current = rows.get(rate) ?? {
    gstRate: rate,
    taxableAmount: 0,
    cgstAmount: 0,
    sgstAmount: 0,
    igstAmount: 0,
    cessAmount: 0,
    invoiceCount: 0,
  };

  current.taxableAmount += taxable;
  current.cgstAmount += cgst;
  current.sgstAmount += sgst;
  current.igstAmount += igst;
  current.invoiceCount += invoiceCount;
  rows.set(rate, current);
}

function finalizeTaxRows(
  rows: Map<number, {
    gstRate: number;
    taxableAmount: number;
    cgstAmount: number;
    sgstAmount: number;
    igstAmount: number;
    cessAmount: number;
    invoiceCount: number;
  }>,
) {
  return [...rows.values()]
    .map((row) => ({
      ...row,
      taxableAmount: roundMoney(row.taxableAmount),
      cgstAmount: roundMoney(row.cgstAmount),
      sgstAmount: roundMoney(row.sgstAmount),
      igstAmount: roundMoney(row.igstAmount),
      cessAmount: roundMoney(row.cessAmount),
    }))
    .sort((a, b) => a.gstRate - b.gstRate);
}

export async function getGstr1(
  businessId: string,
  filters: GstReportFilters = {},
) {
  if (!businessId) throw new AppError("Business context is required", 400);

  const invoices = await prisma.sale.findMany({
    where: {
      businessId,
      deletedAt: null,
      status: { notIn: ["DRAFT", "CANCELLED"] },
      ...dateWhere(filters),
    },
    orderBy: [{ date: "asc" }, { invoiceNumber: "asc" }],
    take: 10000,
    select: {
      id: true,
      invoiceNumber: true,
      date: true,
      placeOfSupply: true,
      isInterState: true,
      taxableAmount: true,
      cgstAmount: true,
      sgstAmount: true,
      igstAmount: true,
      cessAmount: true,
      grandTotal: true,
      customer: {
        select: {
          name: true,
          gstin: true,
          state: true,
        },
      },
      items: {
        select: {
          itemName: true,
          hsnSac: true,
          quantity: true,
          gstRate: true,
          taxableAmount: true,
          cgstAmount: true,
          sgstAmount: true,
          igstAmount: true,
          amount: true,
        },
      },
    },
  });

  const rateRows = new Map<number, {
    gstRate: number;
    taxableAmount: number;
    cgstAmount: number;
    sgstAmount: number;
    igstAmount: number;
    cessAmount: number;
    invoiceCount: number;
  }>();

  const hsnRows = new Map<string, {
    hsnSac: string;
    description: string;
    quantity: number;
    taxableAmount: number;
    cgstAmount: number;
    sgstAmount: number;
    igstAmount: number;
    totalTax: number;
  }>();

  let taxableTotal = 0;
  let cgstTotal = 0;
  let sgstTotal = 0;
  let igstTotal = 0;
  let cessTotal = 0;
  let invoiceTotal = 0;
  let b2bCount = 0;
  let b2cCount = 0;

  const invoiceRows = invoices.map((invoice) => {
    const taxable = money(invoice.taxableAmount);
    const cgst = money(invoice.cgstAmount);
    const sgst = money(invoice.sgstAmount);
    const igst = money(invoice.igstAmount);
    const cess = money(invoice.cessAmount);
    const gstin = invoice.customer?.gstin?.trim().toUpperCase() || null;

    taxableTotal += taxable;
    cgstTotal += cgst;
    sgstTotal += sgst;
    igstTotal += igst;
    cessTotal += cess;
    invoiceTotal += money(invoice.grandTotal);

    if (gstin) b2bCount += 1;
    else b2cCount += 1;

    for (const item of invoice.items) {
      const rate = money(item.gstRate);

      addTaxRow(
        rateRows,
        rate,
        money(item.taxableAmount),
        money(item.cgstAmount),
        money(item.sgstAmount),
        money(item.igstAmount),
      );

      const hsn = item.hsnSac?.trim() || "UNSPECIFIED";
      const hsnRow = hsnRows.get(hsn) ?? {
        hsnSac: hsn,
        description: item.itemName,
        quantity: 0,
        taxableAmount: 0,
        cgstAmount: 0,
        sgstAmount: 0,
        igstAmount: 0,
        totalTax: 0,
      };

      hsnRow.quantity += money(item.quantity);
      hsnRow.taxableAmount += money(item.taxableAmount);
      hsnRow.cgstAmount += money(item.cgstAmount);
      hsnRow.sgstAmount += money(item.sgstAmount);
      hsnRow.igstAmount += money(item.igstAmount);
      hsnRow.totalTax +=
        money(item.cgstAmount) +
        money(item.sgstAmount) +
        money(item.igstAmount);

      hsnRows.set(hsn, hsnRow);
    }

    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      date: invoice.date,
      customerName: invoice.customer?.name ?? "Walk-in customer",
      customerGstin: gstin,
      placeOfSupply: invoice.placeOfSupply ?? invoice.customer?.state ?? null,
      supplyType: invoice.isInterState ? "INTER_STATE" : "INTRA_STATE",
      taxableAmount: roundMoney(taxable),
      cgstAmount: roundMoney(cgst),
      sgstAmount: roundMoney(sgst),
      igstAmount: roundMoney(igst),
      cessAmount: roundMoney(cess),
      invoiceValue: roundMoney(money(invoice.grandTotal)),
      items: invoice.items.map((item) => ({
        itemName: item.itemName,
        hsnSac: item.hsnSac,
        quantity: money(item.quantity),
        gstRate: money(item.gstRate),
        taxableAmount: roundMoney(money(item.taxableAmount)),
        cgstAmount: roundMoney(money(item.cgstAmount)),
        sgstAmount: roundMoney(money(item.sgstAmount)),
        igstAmount: roundMoney(money(item.igstAmount)),
        amount: roundMoney(money(item.amount)),
      })),
    };
  });

  return {
    reportType: "GSTR-1",
    period: {
      from: filters.from ?? null,
      to: filters.to ?? null,
    },
    counts: {
      invoices: invoices.length,
      b2bInvoices: b2bCount,
      invoicesWithoutCustomerGstin: b2cCount,
      truncated: invoices.length === 10000,
    },
    totals: {
      invoiceValue: roundMoney(invoiceTotal),
      taxableAmount: roundMoney(taxableTotal),
      cgstAmount: roundMoney(cgstTotal),
      sgstAmount: roundMoney(sgstTotal),
      igstAmount: roundMoney(igstTotal),
      cessAmount: roundMoney(cessTotal),
      totalTax: roundMoney(cgstTotal + sgstTotal + igstTotal + cessTotal),
    },
    taxRateSummary: finalizeTaxRows(rateRows),
    hsnSummary: [...hsnRows.values()].map((row) => ({
      ...row,
      quantity: roundMoney(row.quantity),
      taxableAmount: roundMoney(row.taxableAmount),
      cgstAmount: roundMoney(row.cgstAmount),
      sgstAmount: roundMoney(row.sgstAmount),
      igstAmount: roundMoney(row.igstAmount),
      totalTax: roundMoney(row.totalTax),
    })),
    invoices: invoiceRows,
  };
}

export async function getGstr2(
  businessId: string,
  filters: GstReportFilters = {},
) {
  if (!businessId) throw new AppError("Business context is required", 400);

  const invoices = await prisma.purchase.findMany({
    where: {
      businessId,
      deletedAt: null,
      status: { notIn: ["DRAFT", "CANCELLED"] },
      ...dateWhere(filters),
    },
    orderBy: [{ date: "asc" }, { billNumber: "asc" }],
    take: 10000,
    select: {
      id: true,
      billNumber: true,
      date: true,
      placeOfSupply: true,
      isInterState: true,
      taxableAmount: true,
      cgstAmount: true,
      sgstAmount: true,
      igstAmount: true,
      cessAmount: true,
      grandTotal: true,
      supplier: {
        select: {
          name: true,
          gstin: true,
          state: true,
        },
      },
      items: {
        select: {
          itemName: true,
          hsnSac: true,
          quantity: true,
          gstRate: true,
          taxableAmount: true,
          cgstAmount: true,
          sgstAmount: true,
          igstAmount: true,
          amount: true,
        },
      },
    },
  });

  const rateRows = new Map<number, {
    gstRate: number;
    taxableAmount: number;
    cgstAmount: number;
    sgstAmount: number;
    igstAmount: number;
    cessAmount: number;
    invoiceCount: number;
  }>();

  let taxableTotal = 0;
  let cgstTotal = 0;
  let sgstTotal = 0;
  let igstTotal = 0;
  let cessTotal = 0;
  let invoiceTotal = 0;

  const invoiceRows = invoices.map((invoice) => {
    const taxable = money(invoice.taxableAmount);
    const cgst = money(invoice.cgstAmount);
    const sgst = money(invoice.sgstAmount);
    const igst = money(invoice.igstAmount);
    const cess = money(invoice.cessAmount);

    taxableTotal += taxable;
    cgstTotal += cgst;
    sgstTotal += sgst;
    igstTotal += igst;
    cessTotal += cess;
    invoiceTotal += money(invoice.grandTotal);

    for (const item of invoice.items) {
      addTaxRow(
        rateRows,
        money(item.gstRate),
        money(item.taxableAmount),
        money(item.cgstAmount),
        money(item.sgstAmount),
        money(item.igstAmount),
      );
    }

    return {
      id: invoice.id,
      billNumber: invoice.billNumber,
      date: invoice.date,
      supplierName: invoice.supplier?.name ?? "Unspecified supplier",
      supplierGstin: invoice.supplier?.gstin?.trim().toUpperCase() || null,
      placeOfSupply: invoice.placeOfSupply ?? invoice.supplier?.state ?? null,
      supplyType: invoice.isInterState ? "INTER_STATE" : "INTRA_STATE",
      taxableAmount: roundMoney(taxable),
      cgstAmount: roundMoney(cgst),
      sgstAmount: roundMoney(sgst),
      igstAmount: roundMoney(igst),
      cessAmount: roundMoney(cess),
      invoiceValue: roundMoney(money(invoice.grandTotal)),
      items: invoice.items.map((item) => ({
        itemName: item.itemName,
        hsnSac: item.hsnSac,
        quantity: money(item.quantity),
        gstRate: money(item.gstRate),
        taxableAmount: roundMoney(money(item.taxableAmount)),
        cgstAmount: roundMoney(money(item.cgstAmount)),
        sgstAmount: roundMoney(money(item.sgstAmount)),
        igstAmount: roundMoney(money(item.igstAmount)),
        amount: roundMoney(money(item.amount)),
      })),
    };
  });

  return {
    reportType: "GSTR-2",
    period: {
      from: filters.from ?? null,
      to: filters.to ?? null,
    },
    counts: {
      invoices: invoices.length,
      invoicesWithoutSupplierGstin: invoices.filter(
        (invoice) => !invoice.supplier?.gstin?.trim(),
      ).length,
      truncated: invoices.length === 10000,
    },
    totals: {
      invoiceValue: roundMoney(invoiceTotal),
      taxableAmount: roundMoney(taxableTotal),
      cgstAmount: roundMoney(cgstTotal),
      sgstAmount: roundMoney(sgstTotal),
      igstAmount: roundMoney(igstTotal),
      cessAmount: roundMoney(cessTotal),
      totalTax: roundMoney(cgstTotal + sgstTotal + igstTotal + cessTotal),
    },
    taxRateSummary: finalizeTaxRows(rateRows),
    invoices: invoiceRows,
  };
}

export async function getGstr3b(
  businessId: string,
  filters: GstReportFilters = {},
) {
  if (!businessId) throw new AppError("Business context is required", 400);

  const [sales, purchases] = await Promise.all([
    prisma.sale.findMany({
      where: {
        businessId,
        deletedAt: null,
        status: { notIn: ["DRAFT", "CANCELLED"] },
        ...dateWhere(filters),
      },
      select: {
        taxableAmount: true,
        cgstAmount: true,
        sgstAmount: true,
        igstAmount: true,
        cessAmount: true,
        grandTotal: true,
      },
      take: 10000,
    }),
    prisma.purchase.findMany({
      where: {
        businessId,
        deletedAt: null,
        status: { notIn: ["DRAFT", "CANCELLED"] },
        ...dateWhere(filters),
      },
      select: {
        taxableAmount: true,
        cgstAmount: true,
        sgstAmount: true,
        igstAmount: true,
        cessAmount: true,
        grandTotal: true,
      },
      take: 10000,
    }),
  ]);

  function summarize(rows: typeof sales) {
    return rows.reduce(
      (totals, row) => {
        totals.invoiceValue += money(row.grandTotal);
        totals.taxableAmount += money(row.taxableAmount);
        totals.cgstAmount += money(row.cgstAmount);
        totals.sgstAmount += money(row.sgstAmount);
        totals.igstAmount += money(row.igstAmount);
        totals.cessAmount += money(row.cessAmount);
        return totals;
      },
      {
        invoiceValue: 0,
        taxableAmount: 0,
        cgstAmount: 0,
        sgstAmount: 0,
        igstAmount: 0,
        cessAmount: 0,
      },
    );
  }

  const outward = summarize(sales);
  const inward = summarize(purchases);

  const netTax = {
    cgstAmount: roundMoney(outward.cgstAmount - inward.cgstAmount),
    sgstAmount: roundMoney(outward.sgstAmount - inward.sgstAmount),
    igstAmount: roundMoney(outward.igstAmount - inward.igstAmount),
    cessAmount: roundMoney(outward.cessAmount - inward.cessAmount),
  };

  return {
    reportType: "GSTR-3B",
    period: {
      from: filters.from ?? null,
      to: filters.to ?? null,
    },
    outwardSupplies: {
      invoiceCount: sales.length,
      ...Object.fromEntries(
        Object.entries(outward).map(([key, value]) => [key, roundMoney(value)]),
      ),
      totalTax: roundMoney(
        outward.cgstAmount +
          outward.sgstAmount +
          outward.igstAmount +
          outward.cessAmount,
      ),
    },
    inwardSupplies: {
      invoiceCount: purchases.length,
      ...Object.fromEntries(
        Object.entries(inward).map(([key, value]) => [key, roundMoney(value)]),
      ),
      totalTax: roundMoney(
        inward.cgstAmount +
          inward.sgstAmount +
          inward.igstAmount +
          inward.cessAmount,
      ),
    },
    indicativeNetTaxAfterPurchaseTaxOffset: {
      ...netTax,
      total: roundMoney(
        netTax.cgstAmount +
          netTax.sgstAmount +
          netTax.igstAmount +
          netTax.cessAmount,
      ),
      note:
        "Indicative arithmetic only. This is not a statutory ITC eligibility calculation or a filing-ready tax liability.",
    },
    limits: {
      salesTruncated: sales.length === 10000,
      purchasesTruncated: purchases.length === 10000,
    },
  };
}