import { Router, type Response } from "express";
import { z } from "zod";

import { authenticate, type AuthRequest } from "../middleware/auth";
import { asyncHandler, AppError } from "../middleware/errorHandler";
import * as expensesService from "../services/expenses.service";

const router = Router();

const expenseSchema = z.object({
  amount: z.coerce.number().finite().positive(),
  date: z.coerce.date().optional(),
  categoryId: z.string().trim().min(1).nullable().optional(),
  category: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  paymentMethod: z.string().trim().max(50).nullable().optional(),
  bankAccountId: z.string().trim().min(1).nullable().optional(),
  attachmentUrl: z.string().trim().max(2048).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

function parseOptionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === "") return undefined;

  if (typeof value !== "string") {
    throw new AppError(`Invalid ${field} date`, 400);
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new AppError(`Invalid ${field} date`, 400);
  }

  return date;
}

/**
 * GET /expenses
 * List expenses with optional search, category and date filters.
 */
router.get(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);

    if (!Number.isInteger(page) || page < 1) {
      throw new AppError("page must be a positive integer", 400);
    }

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new AppError("limit must be between 1 and 100", 400);
    }

    const search =
      typeof req.query.search === "string"
        ? req.query.search.trim()
        : undefined;

    const categoryId =
      typeof req.query.categoryId === "string"
        ? req.query.categoryId.trim()
        : undefined;

    const from = parseOptionalDate(req.query.from, "from");
    const to = parseOptionalDate(req.query.to, "to");

    const result = await expensesService.listExpenses(req.businessId!, {
      page,
      limit,
      search,
      categoryId,
      from,
      to,
    });

    return res.json({
      success: true,
      ...result,
    });
  }),
);

/**
 * GET /expenses/categories
 * List categories belonging to the authenticated business.
 */
router.get(
  "/categories",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await expensesService.listExpenseCategories(
      req.businessId!,
    );

    return res.json({
      success: true,
      data,
    });
  }),
);

/**
 * GET /expenses/:id
 * Fetch one expense belonging to the authenticated business.
 */
router.get(
  "/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const data = await expensesService.getExpense(
      req.businessId!,
      id,
    );

    return res.json({
      success: true,
      data,
    });
  }),
);

/**
 * POST /expenses
 * Create an expense.
 */
router.post(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const input = expenseSchema.parse(req.body);

    const data = await expensesService.createExpense(
      req.businessId!,
      {
        ...input,
        createdById: req.user?.userId ?? null,
      },
    );

    return res.status(201).json({
      success: true,
      data,
    });
  }),
);

export default router;
