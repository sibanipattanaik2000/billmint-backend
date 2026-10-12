import { Router, Response } from "express";
import { z } from "zod";

import { authenticate, AuthRequest } from "../middleware/auth";
import { asyncHandler, AppError } from "../middleware/errorHandler";
import {
  createPaymentIn,
  createPaymentOut,
  listPaymentsIn,
  listPaymentsOut,
} from "../services/payments.service";

const router = Router();

const allocationSchema = z.object({
  invoiceId: z.string().uuid("Invalid invoice ID"),
  amount: z.coerce.number().finite().positive(),
});

const createPaymentSchema = z.object({
  customerId: z.string().uuid().nullable().optional(),
  supplierId: z.string().uuid().nullable().optional(),
  amount: z.coerce.number().finite().positive(),
  date: z.coerce.date().optional(),
  paymentMethod: z.string().trim().min(1).max(50),
  reference: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  bankAccountId: z.string().uuid().nullable().optional(),
  allocations: z.array(allocationSchema).max(100).optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * GET /
 * List payments for the authenticated business.
 *
 * Mount this router at /payments/in for receipts and
 * /payments/out for supplier payments.
 */
router.get(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = listQuerySchema.parse(req.query);

    if (query.from && query.to && query.from > query.to) {
      throw new AppError("'from' date cannot be after 'to' date", 400);
    }

    const data = await listPaymentsIn(req.businessId!, query);

    return res.json({
      success: true,
      ...data,
    });
  }),
);

/**
 * POST /
 * Record money received from a customer.
 */
router.post(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = createPaymentSchema.parse(req.body);

    const data = await createPaymentIn(req.businessId!, {
      ...body,
      createdById: req.user?.userId,
    });

    return res.status(201).json({
      success: true,
      data,
    });
  }),
);

/**
 * GET /out
 * List supplier payments.
 */
router.get(
  "/out",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = listQuerySchema.parse(req.query);

    if (query.from && query.to && query.from > query.to) {
      throw new AppError("'from' date cannot be after 'to' date", 400);
    }

    const data = await listPaymentsOut(req.businessId!, query);

    return res.json({
      success: true,
      ...data,
    });
  }),
);

/**
 * POST /out
 * Record money paid to a supplier.
 */
router.post(
  "/out",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = createPaymentSchema.parse(req.body);

    const data = await createPaymentOut(req.businessId!, {
      ...body,
      createdById: req.user?.userId,
    });

    return res.status(201).json({
      success: true,
      data,
    });
  }),
);

export default router;
