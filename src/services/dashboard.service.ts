import prisma from "../utils/prisma";
import { toDecimal, roundMoney } from "../utils/money";

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export async function getDashboard(businessId: string) {
  const todayStart = startOfDay();
  const todayEnd = endOfDay();
  const monthStart = new Date(
    todayStart.getFullYear(),
    todayStart.getMonth(),
    1,
  );

  const [
    todaySales,
    todayPurchases,
    todayExpenses,
    receivables,
    payables,
    cashAccounts,
    bankAccounts,
    stockItems,
    recentSales,
    recentPurchases,
    lowStockItems,
    outstandingSales,
    topCustomers,
    salesTrend,
  ] = await Promise.all([
    prisma.sale.aggregate({
      where: {
        businessId,
        deletedAt: null,
        status: { not: "CANCELLED" },
        date: { gte: todayStart, lte: todayEnd },
      },
      _sum: { grandTotal: true },
      _count: true,
    }),
    prisma.purchase.aggregate({
      where: {
        businessId,
        deletedAt: null,
        status: { not: "CANCELLED" },
        date: { gte: todayStart, lte: todayEnd },
      },
      _sum: { grandTotal: true },
      _count: true,
    }),
    prisma.expense.aggregate({
      where: { businessId, date: { gte: todayStart, lte: todayEnd } },
      _sum: { amount: true },
    }),
    prisma.customer.aggregate({
      where: { businessId, deletedAt: null, currentBalance: { gt: 0 } },
      _sum: { currentBalance: true },
    }),
    prisma.supplier.aggregate({
      where: { businessId, deletedAt: null, currentBalance: { gt: 0 } },
      _sum: { currentBalance: true },
    }),
    prisma.bankAccount.findMany({
      where: { businessId, isCash: true, status: "ACTIVE" },
    }),
    prisma.bankAccount.findMany({
      where: { businessId, isCash: false, status: "ACTIVE" },
    }),
    prisma.item.findMany({
      where: { businessId, deletedAt: null, status: "ACTIVE" },
      select: { currentStock: true, purchasePrice: true },
    }),
    prisma.sale.findMany({
      where: { businessId, deletedAt: null },
      include: { customer: { select: { name: true } } },
      orderBy: { date: "desc" },
      take: 10,
    }),
    prisma.purchase.findMany({
      where: { businessId, deletedAt: null },
      include: { supplier: { select: { name: true } } },
      orderBy: { date: "desc" },
      take: 10,
    }),
    prisma.item.findMany({
      where: {
        businessId,
        deletedAt: null,
        status: "ACTIVE",
        minimumStock: { gt: 0 },
      },
      select: {
        id: true,
        name: true,
        currentStock: true,
        minimumStock: true,
        unit: { select: { shortName: true } },
      },
      take: 20,
    }),
    prisma.sale.findMany({
      where: {
        businessId,
        deletedAt: null,
        status: { in: ["UNPAID", "PARTIALLY_PAID", "OVERDUE"] },
        balanceAmount: { gt: 0 },
      },
      include: { customer: { select: { name: true } } },
      orderBy: { dueDate: "asc" },
      take: 10,
    }),
    prisma.customer.findMany({
      where: { businessId, deletedAt: null },
      orderBy: { currentBalance: "desc" },
      take: 5,
      select: { id: true, name: true, currentBalance: true },
    }),
    // Last 7 days sales
    prisma.$queryRaw`
  SELECT
    DATE("date") AS day,
    SUM("grandTotal") AS total,
    COUNT(*) AS count
  FROM "sales"
  WHERE "businessId" = ${businessId}::uuid
    AND "deletedAt" IS NULL
    AND "status" != 'CANCELLED'
    AND "date" >= ${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)}
  GROUP BY DATE("date")
  ORDER BY day ASC
`.catch(() => []),
  ]);

  // Filter low stock in JS (Prisma comparison of two fields is limited)
  const lowStock = lowStockItems.filter((i) =>
    toDecimal(i.currentStock).lte(toDecimal(i.minimumStock)),
  );

  let stockValue = toDecimal(0);
  for (const item of stockItems) {
    stockValue = stockValue.plus(
      toDecimal(item.currentStock).mul(toDecimal(item.purchasePrice)),
    );
  }

  const cashBalance = cashAccounts.reduce(
    (s, a) => s.plus(toDecimal(a.currentBalance)),
    toDecimal(0),
  );
  const bankBalance = bankAccounts.reduce(
    (s, a) => s.plus(toDecimal(a.currentBalance)),
    toDecimal(0),
  );

  // Month P&L approximation
  const monthSales = await prisma.sale.aggregate({
    where: {
      businessId,
      deletedAt: null,
      status: { not: "CANCELLED" },
      date: { gte: monthStart },
    },
    _sum: { grandTotal: true },
  });
  const monthPurchases = await prisma.purchase.aggregate({
    where: {
      businessId,
      deletedAt: null,
      status: { not: "CANCELLED" },
      date: { gte: monthStart },
    },
    _sum: { grandTotal: true },
  });
  const monthExpenses = await prisma.expense.aggregate({
    where: { businessId, date: { gte: monthStart } },
    _sum: { amount: true },
  });

  const monthProfit = toDecimal(monthSales._sum.grandTotal || 0)
    .minus(toDecimal(monthPurchases._sum.grandTotal || 0))
    .minus(toDecimal(monthExpenses._sum.amount || 0));

  return {
    cards: {
      todaySale: roundMoney(
        toDecimal(todaySales._sum.grandTotal || 0),
      ).toNumber(),
      todaySaleCount: todaySales._count,
      todayPurchase: roundMoney(
        toDecimal(todayPurchases._sum.grandTotal || 0),
      ).toNumber(),
      todayPurchaseCount: todayPurchases._count,
      todayExpense: roundMoney(
        toDecimal(todayExpenses._sum.amount || 0),
      ).toNumber(),
      receivables: roundMoney(
        toDecimal(receivables._sum.currentBalance || 0),
      ).toNumber(),
      payables: roundMoney(
        toDecimal(payables._sum.currentBalance || 0),
      ).toNumber(),
      cashBalance: roundMoney(cashBalance).toNumber(),
      bankBalance: roundMoney(bankBalance).toNumber(),
      stockValue: roundMoney(stockValue).toNumber(),
      monthProfit: roundMoney(monthProfit).toNumber(),
    },
    recentSales,
    recentPurchases,
    lowStock,
    outstandingPayments: outstandingSales,
    topCustomers,
    salesTrend,
  };
}
