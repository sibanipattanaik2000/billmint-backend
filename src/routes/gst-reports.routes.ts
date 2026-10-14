import { Router, Response } from "express";
import { z } from "zod";
import { authenticate, AuthRequest } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import * as gstReportsService from "../services/gst-reports.service";

const router = Router();

const dateQuerySchema = z.object({
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
});

function parseDateFilters(query: unknown) {
  const parsed = dateQuerySchema.safeParse(query);

  if (!parsed.success) {
    throw new AppError("Invalid GST report date filters", 400);
  }

  const { from, to } = parsed.data;

  function parseDate(value: string | undefined, endOfDay = false) {
    if (!value) return undefined;

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
      throw new AppError("Invalid GST report date", 400);
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
  "/gstr1",
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await gstReportsService.getGstr1(
      req.businessId!,
      parseDateFilters(req.query),
    );

    res.json({ success: true, data });
  }),
);

router.get(
  "/gstr2",
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await gstReportsService.getGstr2(
      req.businessId!,
      parseDateFilters(req.query),
    );

    res.json({ success: true, data });
  }),
);

router.get(
  "/gstr3b",
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await gstReportsService.getGstr3b(
      req.businessId!,
      parseDateFilters(req.query),
    );

    res.json({ success: true, data });
  }),
);

export default router;