import { Router, type Response } from "express";
import { z } from "zod";

import { authenticate, type AuthRequest } from "../middleware/auth";
import { asyncHandler, AppError } from "../middleware/errorHandler";
import * as otherIncomeService from "../services/other-income.service";
import * as otherIncomeMutationsService from "../services/other-income-mutations.service";
const router = Router();

const createOtherIncomeSchema = z.object({
  amount: z.coerce.number().finite().positive(),
  date: z.coerce.date().optional(),
  category: z.string().trim().max(200).nullable().optional(),
  paymentMethod: z.string().trim().min(1).max(50),
  description: z.string().trim().max(1000).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  reference: z.string().trim().max(200).nullable().optional(),
  bankAccountId: z.string().uuid().nullable().optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

router.get(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = listQuerySchema.parse(req.query);

    if (query.from && query.to && query.from > query.to) {
      throw new AppError("'from' date cannot be after 'to' date", 400);
    }

    const result = await otherIncomeService.listOtherIncome(
      req.businessId!,
      query,
    );

    return res.json({
      success: true,
      ...result,
    });
  }),
);

router.get(
  "/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await otherIncomeService.getOtherIncome(
      req.businessId!,
      String(req.params.id),
    );

    return res.json({
      success: true,
      data,
    });
  }),
);

router.post(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const input = createOtherIncomeSchema.parse(req.body);

    const data = await otherIncomeService.createOtherIncome(
      req.businessId!,
      input,
    );

    return res.status(201).json({
      success: true,
      data,
    });
  }),
);
/**
 * PATCH /other-income/:id
 * Update an income record and reconcile its cash/bank balance.
 */
router.patch(
  "/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const input = createOtherIncomeSchema.partial().parse(req.body);

    const data = await otherIncomeMutationsService.updateOtherIncome(
      req.businessId!,
      String(req.params.id),
      input,
    );

    return res.status(200).json({
      success: true,
      data,
    });
  }),
);

/**
 * DELETE /other-income/:id
 * Delete an income record and reverse its cash/bank impact.
 */
router.delete(
  "/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await otherIncomeMutationsService.deleteOtherIncome(
      req.businessId!,
      String(req.params.id),
    );

    return res.status(200).json({
      success: true,
      data,
    });
  }),
);
export default router;
