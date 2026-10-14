import { Router, Response } from "express";
import { z } from "zod";
import { authenticate, AuthRequest } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import * as partyStatementService from "../services/party-statement.service";

const router = Router();

const querySchema = z.object({
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
});

function parseFilters(query: unknown) {
  const parsed = querySchema.safeParse(query);

  if (!parsed.success) {
    throw new AppError("Invalid statement date filters", 400);
  }

  function parseDate(value?: string, endOfDay = false) {
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
      throw new AppError("Invalid statement date", 400);
    }

    return date;
  }

  const from = parseDate(parsed.data.from);
  const to = parseDate(parsed.data.to, true);

  if (from && to && from > to) {
    throw new AppError("'from' date cannot be later than 'to' date", 400);
  }

  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

router.use(authenticate);

router.get(
  "/customers/:id",
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = z.string().uuid().safeParse(req.params.id);

    if (!id.success) {
      throw new AppError("Invalid customer ID", 400);
    }

    const data = await partyStatementService.getCustomerStatement(
      req.businessId!,
      id.data,
      parseFilters(req.query),
    );

    res.json({ success: true, data });
  }),
);

router.get(
  "/suppliers/:id",
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = z.string().uuid().safeParse(req.params.id);

    if (!id.success) {
      throw new AppError("Invalid supplier ID", 400);
    }

    const data = await partyStatementService.getSupplierStatement(
      req.businessId!,
      id.data,
      parseFilters(req.query),
    );

    res.json({ success: true, data });
  }),
);

export default router;