import { Router, Response } from "express";
import { z } from "zod";
import {
  authenticate,
  AuthRequest,
  requireStoreRole,
} from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import * as reportsService from "../services/reports.service";
import prisma from "../utils/prisma";

const router = Router();

const dateQuerySchema = z.object({
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
});

function parseDateFilters(query: unknown) {
  const parsed = dateQuerySchema.safeParse(query);

  if (!parsed.success) {
    throw new AppError("Invalid report date filters", 400);
  }

  const { from, to } = parsed.data;

  function parseDate(value: string | undefined, endOfDay = false) {
    if (!value) return undefined;

    // Accept YYYY-MM-DD only to avoid timezone ambiguity.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new AppError("Dates must use YYYY-MM-DD format", 400);
    }

    const date = new Date(
      `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`,
    );

    if (
      Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
    ) {
      throw new AppError("Invalid report date", 400);
    }

    return date;
  }

  const fromDate = parseDate(from);
  const toDate = parseDate(to, true);

  if (fromDate && toDate && fromDate > toDate) {
    throw new AppError("'from' date cannot be later than 'to' date", 400);
  }

  return {
    ...(fromDate ? { from: fromDate } : {}),
    ...(toDate ? { to: toDate } : {}),
  };
}

router.use(authenticate);

router.get(
  "/sale-summary",
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await reportsService.getSaleSummary(
      req.businessId!,
      parseDateFilters(req.query),
    );

    res.json({ success: true, data });
  }),
);

router.get(
  "/party-wise-sales",
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await reportsService.getPartyWiseSales(
      req.businessId!,
      parseDateFilters(req.query),
    );

    res.json({ success: true, data });
  }),
);

router.get(
  "/item-wise-sales",
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await reportsService.getItemWiseSales(
      req.businessId!,
      parseDateFilters(req.query),
    );

    res.json({ success: true, data });
  }),
);

router.get(
  "/purchase-summary",
  requireStoreRole("CENTRAL"),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await reportsService.getPurchaseSummary(
      req.businessId!,
      parseDateFilters(req.query),
    );

    res.json({ success: true, data });
  }),
);

router.get(
  "/stock-summary",
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await reportsService.getStockSummary(req.businessId!);

    const business = await prisma.business.findUnique({
      where: { id: req.businessId! },
      select: { storeRole: true },
    });

    if (business?.storeRole === "CENTRAL") {
      res.json({ success: true, data });
      return;
    }

    const { stockCostValue: _hiddenCost, ...safeSummary } = data.summary;

    const safeData = data.data.map(
      ({
        purchasePrice: _hiddenPurchasePrice,
        stockCostValue: _hiddenItemCost,
        ...item
      }) => item,
    );

    res.json({
      success: true,
      data: {
        ...data,
        summary: safeSummary,
        data: safeData,
      },
    });
  }),
);

router.get(
  "/low-stock",
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await reportsService.getLowStockReport(req.businessId!);

    const business = await prisma.business.findUnique({
      where: { id: req.businessId! },
      select: { storeRole: true },
    });

    const responseData =
      business?.storeRole === "CENTRAL"
        ? data
        : data.map(({ stockCostValue: _hiddenCost, ...item }) => item);

    res.json({ success: true, data: responseData });
  }),
);

router.get(
  "/receivable",
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await reportsService.getReceivableReport(
      req.businessId!,
      parseDateFilters(req.query),
    );

    res.json({ success: true, data });
  }),
);

router.get(
  "/payable",
  requireStoreRole("CENTRAL"),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await reportsService.getPayableReport(
      req.businessId!,
      parseDateFilters(req.query),
    );

    res.json({ success: true, data });
  }),
);

router.get(
  "/expense",
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await reportsService.getExpenseReport(
      req.businessId!,
      parseDateFilters(req.query),
    );

    res.json({ success: true, data });
  }),
);
router.get(
  "/payment-collection",
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const filters = parseDateFilters(req.query);

    const data = await reportsService.getPaymentCollectionReport(
      req.businessId!,
      filters,
    );

    res.json({
      success: true,
      data,
    });
  }),
);
export default router;
