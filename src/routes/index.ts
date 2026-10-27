import { Router, Response } from "express";
import storesRoutes from "./stores.routes";
import authRoutes from "./auth.routes";
import {
  authenticate,
  requirePermission,
  AuthRequest,
} from "../middleware/auth";
import { asyncHandler, AppError } from "../middleware/errorHandler";
import { z } from "zod";
import * as dashboardService from "../services/dashboard.service";
import * as customersService from "../services/customers.service";
import * as itemsService from "../services/items.service";
import * as salesService from "../services/sales.service";
import purchasesRoutes from "./purchases.routes";
import suppliersRoutes from "./suppliers.routes";
import expensesRoutes from "./expenses.routes";
import otherIncomeRoutes from "./other-income.routes";
import paymentsRoutes from "./payments.routes";
import bankAccountsRoutes from "./bank-accounts.routes";
import quotationsRoutes from "./quotations.routes";
import deliveryChallansRoutes from "./delivery-challans.routes";
import saleReturnsRoutes from "./sale-returns.routes";
import purchaseReturnsRoutes from "./purchase-returns.routes";
import reportsRoutes from "./reports.routes";
import gstReportsRoutes from "./gst-reports.routes";
import partyStatementRoutes from "./party-statement.routes";
import cashBankStatementRoutes from "./cash-bank-statement.routes";
import businessSettingsRoutes from "./business-settings.routes";
import shelvesRoutes from "./shelves.routes";
import {
  customerSchema,
  itemSchema,
  saleSchema,
  paginationSchema,
} from "../validators/common";
import prisma from "../utils/prisma";

const router = Router();
function serializeBigInt<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  ) as T;
}
router.use("/auth", authRoutes);
router.use("/purchases", purchasesRoutes);
router.use("/purchase-returns", purchaseReturnsRoutes);
router.use("/suppliers", suppliersRoutes);
router.use("/expenses", expensesRoutes);
router.use("/other-income", otherIncomeRoutes);
router.use("/payments", paymentsRoutes);
router.use("/cash-bank", bankAccountsRoutes);
router.use("/quotations", quotationsRoutes);
router.use("/delivery-challans", deliveryChallansRoutes);
router.use("/sale-returns", saleReturnsRoutes);
router.use("/reports", reportsRoutes);
router.use("/reports", gstReportsRoutes);
router.use("/party-statement", partyStatementRoutes);
router.use("/cash-bank", cashBankStatementRoutes);
router.use("/business-settings", businessSettingsRoutes);
router.use("/shelves", shelvesRoutes);
router.use("/stores", storesRoutes);
/* =========================================================
   DASHBOARD
========================================================= */

router.get(
  "/dashboard",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await dashboardService.getDashboard(req.businessId!);

    res.json({
      success: true,
      data: serializeBigInt(data),
    });
  }),
);
/* =========================================================
   CUSTOMERS
========================================================= */

router.get(
  "/customers",
  authenticate,
  requirePermission("customers.view"),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = paginationSchema.parse(req.query);

    const data = await customersService.listCustomers(req.businessId!, query);

    res.json({
      success: true,
      ...data,
    });
  }),
);

router.post(
  "/customers",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = customerSchema.parse(req.body);

    const data = await customersService.createCustomer(
      req.businessId!,
      body,
      req.user?.userId,
    );

    res.status(201).json({
      success: true,
      data,
    });
  }),
);

router.get(
  "/customers/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const data = await customersService.getCustomer(req.businessId!, id);

    res.json({
      success: true,
      data,
    });
  }),
);

router.patch(
  "/customers/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);
    const body = customerSchema.partial().parse(req.body);

    const data = await customersService.updateCustomer(
      req.businessId!,
      id,
      body,
      req.user?.userId,
    );

    res.json({
      success: true,
      data,
    });
  }),
);

router.delete(
  "/customers/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const data = await customersService.deleteCustomer(
      req.businessId!,
      id,
      req.user?.userId,
    );

    res.json({
      success: true,
      data,
    });
  }),
);

/* =========================================================
   ITEMS
========================================================= */

router.get(
  "/items",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = paginationSchema.parse(req.query);

    const categoryId =
      typeof req.query.categoryId === "string"
        ? req.query.categoryId
        : undefined;

    const lowStock = req.query.lowStock === "true";

    const data = await itemsService.listItems(req.businessId!, {
      ...query,
      categoryId,
      lowStock,
    });

    res.json({
      success: true,
      ...data,
    });
  }),
);
router.get(
  "/items/models",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await itemsService.listItemModels(req.businessId!);

    res.json({
      success: true,
      data,
    });
  }),
);
router.post(
  "/items",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = itemSchema.parse(req.body);

    const data = await itemsService.createItem(
      req.businessId!,
      body,
      req.user?.userId,
    );

    res.status(201).json({
      success: true,
      data,
    });
  }),
);

router.get(
  "/items/barcode/:barcode",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const barcode = String(req.params.barcode);

    const data = await itemsService.searchByBarcode(req.businessId!, barcode);

    res.json({
      success: true,
      data,
    });
  }),
);
router.get(
  "/items/code/:sku",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await itemsService.searchBySku(
      req.businessId!,
      String(req.params.sku),
    );

    res.json({ success: true, data });
  }),
);
router.get(
  "/items/imei/:imei",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await itemsService.searchByImei(
      req.businessId!,
      String(req.params.imei),
    );

    res.json({
      success: true,
      data,
    });
  }),
);
router.get(
  "/stock-adjustments",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = paginationSchema.parse(req.query);

    const itemId =
      typeof req.query.itemId === "string"
        ? req.query.itemId.trim()
        : undefined;

    const data = await itemsService.listStockAdjustments(
      req.businessId!,
      query.page,
      query.limit,
      itemId || undefined,
    );

    res.json({
      success: true,
      ...data,
    });
  }),
);
router.get(
  "/items/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const data = await itemsService.getItem(req.businessId!, id);

    res.json({
      success: true,
      data,
    });
  }),
);

router.patch(
  "/items/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);
    const body = itemSchema.partial().parse(req.body);

    const data = await itemsService.updateItem(
      req.businessId!,
      id,
      body,
      req.user?.userId,
    );

    res.json({
      success: true,
      data,
    });
  }),
);

router.delete(
  "/items/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const data = await itemsService.deleteItem(
      req.businessId!,
      id,
      req.user?.userId,
    );

    res.json({
      success: true,
      data,
    });
  }),
);

router.post(
  "/items/:id/adjust-stock",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const bodySchema = z.object({
      quantity: z.coerce
        .number()
        .finite()
        .refine((value) => value !== 0, "Adjustment quantity cannot be zero"),
      reason: z.string().trim().min(1).max(255),
      notes: z.string().trim().max(5000).optional().nullable(),
    });

    const parsed = bodySchema.safeParse(req.body);

    if (!parsed.success) {
      throw new AppError(
        parsed.error.issues.map((issue) => issue.message).join(", "),
        400,
      );
    }

    const data = await itemsService.adjustStock(
      req.businessId!,
      id,
      parsed.data.quantity,
      parsed.data.reason,
      parsed.data.notes ?? undefined,
      req.user?.userId,
    );

    res.json({
      success: true,
      data,
    });
  }),
);

/* =========================================================
   ALL-STORE SALES OVERVIEW
   Authenticated users can view sales summaries across stores.
   This endpoint does not expose customer details or allow
   cross-store invoice access or modification.
========================================================= */

router.get(
  "/sales/all-stores",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = paginationSchema.parse(req.query);

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));

    const storeCode =
      typeof req.query.storeCode === "string"
        ? req.query.storeCode.trim().toUpperCase()
        : undefined;

    const parseStoreSalesDate = (
      value: string,
      endOfDay = false,
    ): Date => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new AppError("Dates must use YYYY-MM-DD format", 400);
      }

      const parsed = new Date(
        `${value}T${
          endOfDay ? "23:59:59.999" : "00:00:00.000"
        }Z`,
      );

      if (
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== value
      ) {
        throw new AppError("Invalid date filter", 400);
      }

      return parsed;
    };

    const from =
      typeof req.query.from === "string"
        ? parseStoreSalesDate(req.query.from)
        : undefined;

    const to =
      typeof req.query.to === "string"
        ? parseStoreSalesDate(req.query.to, true)
        : undefined;

    if (from && to && from > to) {
      throw new AppError(
        "The from date cannot be after the to date",
        400,
      );
    }

    const where: any = {
      deletedAt: null,
      status: { not: "CANCELLED" },
      business: {
        deletedAt: null,
        ...(storeCode ? { storeCode } : {}),
      },
      ...(from || to
        ? {
            date: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };

    const [storeTotals, overallTotals] = await Promise.all([
      prisma.sale.groupBy({
        by: ["businessId"],
        where,
        _count: {
          _all: true,
        },
        _sum: {
          grandTotal: true,
          paidAmount: true,
          balanceAmount: true,
        },
      }),

      prisma.sale.aggregate({
        where,
        _sum: {
          grandTotal: true,
          paidAmount: true,
          balanceAmount: true,
        },
        _count: {
          _all: true,
        },
      }),
    ]);

    const businesses = await prisma.business.findMany({
      where: {
        id: {
          in: storeTotals.map((entry) => entry.businessId),
        },
        deletedAt: null,
      },
      select: {
        id: true,
        storeCode: true,
        name: true,
      },
    });

    const businessById = new Map(
      businesses.map((business) => [business.id, business]),
    );

    const allStoreSummaries = storeTotals
      .map((entry) => {
        const business = businessById.get(entry.businessId);

        if (!business) {
          return null;
        }

        return {
          storeCode: business.storeCode,
          storeName: business.name,
          invoiceCount: entry._count._all,
          totalSales: entry._sum.grandTotal ?? 0,
          totalReceived: entry._sum.paidAmount ?? 0,
          totalOutstanding: entry._sum.balanceAmount ?? 0,
        };
      })
      .filter((entry) => entry !== null)
      .sort((a, b) => a.storeCode.localeCompare(b.storeCode));

    const total = allStoreSummaries.length;
    const skip = (page - 1) * limit;

    res.json({
      success: true,
      data: allStoreSummaries.slice(skip, skip + limit),
      summary: {
        invoiceCount: overallTotals._count._all,
        totalSales: overallTotals._sum.grandTotal ?? 0,
        totalReceived: overallTotals._sum.paidAmount ?? 0,
        totalOutstanding: overallTotals._sum.balanceAmount ?? 0,
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  }),
);

/* =========================================================
   SALES
========================================================= */

router.get(
  "/sales",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = paginationSchema.parse(req.query);

    const status =
      typeof req.query.status === "string" ? req.query.status : undefined;

    const parseStoreSalesDate = (value: string, endOfDay = false): Date => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new AppError("Dates must use YYYY-MM-DD format", 400);
      }

      const parsed = new Date(
        `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`,
      );

      if (
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== value
      ) {
        throw new AppError("Invalid date filter", 400);
      }

      return parsed;
    };

    const from =
      typeof req.query.from === "string"
        ? parseStoreSalesDate(req.query.from)
        : undefined;

    const to =
      typeof req.query.to === "string"
        ? parseStoreSalesDate(req.query.to, true)
        : undefined;

    if (from && to && from > to) {
      throw new AppError("The from date cannot be after the to date", 400);
    }

    const data = await salesService.getSales(req.businessId!, {
      ...query,
      status,
      from,
      to,
    });

    res.json({
      success: true,
      ...data,
    });
  }),
);

router.post(
  "/sales",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = saleSchema.parse(req.body);

    const data = await salesService.createSale(req.businessId!, {
      ...body,
      createdById: req.user?.userId,
    });

    res.status(201).json({
      success: true,
      data,
    });
  }),
);

router.get(
  "/sales/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const data = await salesService.getSaleById(req.businessId!, id);

    res.json({
      success: true,
      data,
    });
  }),
);
router.put(
  "/sales/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);
    const body = saleSchema.parse(req.body);

    const data = await salesService.updateSale(req.businessId!, id, body);

    res.json({
      success: true,
      data,
    });
  }),
);

router.delete(
  "/sales/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const data = await salesService.deleteSale(req.businessId!, id);

    res.json({
      success: true,
      data,
    });
  }),
);
router.post(
  "/sales/:id/cancel",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const data = await salesService.cancelSale(
      req.businessId!,
      id,
      req.user?.userId,
    );

    res.json({
      success: true,
      data,
    });
  }),
);

/* =========================================================
   HEALTH
========================================================= */

router.get(
  "/health",
  asyncHandler(async (_req, res) => {
    const startedAt = Date.now();

    try {
      await prisma.$queryRaw`SELECT 1`;

      res.status(200).json({
        success: true,
        status: "healthy",
        message: "BillMint API is running",
        database: "connected",
        latencyMs: Date.now() - startedAt,
        version: "1.0.0",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[HEALTH] Database check failed:", error);

      res.status(503).json({
        success: false,
        status: "degraded",
        message: "BillMint API is running but database is unavailable",
        database: "disconnected",
        latencyMs: Date.now() - startedAt,
        version: "1.0.0",
        timestamp: new Date().toISOString(),
      });
    }
  }),
);

export default router;
