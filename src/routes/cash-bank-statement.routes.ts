import { Router, type Response } from "express";
import { z } from "zod";

import { authenticate, type AuthRequest } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import * as statementService from "../services/cash-bank-statement.service";

const router = Router();

const paramsSchema = z.object({
  id: z.string().uuid("Invalid cash/bank account ID"),
});

const querySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function parseDate(value?: string, endOfDay = false): Date | undefined {
  if (!value) return undefined;

  const date = new Date(
    `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`,
  );

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new AppError("Invalid date. Use YYYY-MM-DD format", 400);
  }

  return date;
}

router.get(
  "/:id/statement",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const parsedParams = paramsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      throw new AppError("Invalid cash/bank account ID", 400);
    }

    const parsedQuery = querySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      throw new AppError("Invalid statement filters", 400);
    }

    const from = parseDate(parsedQuery.data.from);
    const to = parseDate(parsedQuery.data.to, true);

    if (from && to && from > to) {
      throw new AppError("'from' date cannot be later than 'to' date", 400);
    }

    const data = await statementService.getCashBankStatement(
      req.businessId!,
      parsedParams.data.id,
      {
        from,
        to,
        page: parsedQuery.data.page,
        limit: parsedQuery.data.limit,
      },
    );

    return res.status(200).json({
      success: true,
      data,
    });
  }),
);

export default router;