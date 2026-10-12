import { Router, type Response } from "express";
import { QuotationStatus } from "@prisma/client";
import { z } from "zod";

import { authenticate, type AuthRequest } from "../middleware/auth";
import { asyncHandler, AppError } from "../middleware/errorHandler";
import * as quotationsService from "../services/quotations.service";
const router = Router();

const quotationItemSchema = z.object({
  itemId: z.string().trim().min(1).nullable().optional(),
  itemName: z.string().trim().max(300).optional(),
  hsnSac: z.string().trim().max(50).nullable().optional(),
  quantity: z.coerce.number().finite().positive(),
  unit: z.string().trim().max(50).nullable().optional(),
  rate: z.coerce.number().finite().min(0),
  discountPercent: z.coerce.number().finite().min(0).max(100).optional(),
  gstRate: z.coerce.number().finite().min(0).max(100).optional(),
});

const createQuotationSchema = z.object({
  customerId: z.string().trim().min(1).nullable().optional(),
  date: z.coerce.date().optional(),
  expiryDate: z.coerce.date().nullable().optional(),
  items: z.array(quotationItemSchema).min(1).max(100),
  notes: z.string().trim().max(5000).nullable().optional(),
  terms: z.string().trim().max(5000).nullable().optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional(),
  status: z.nativeEnum(QuotationStatus).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const updateStatusSchema = z.object({
  status: z.nativeEnum(QuotationStatus),
});

/**
 * GET /quotations
 * List quotations belonging to the authenticated business.
 */
router.get(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = listQuerySchema.parse(req.query);

    if (query.from && query.to && query.from > query.to) {
      throw new AppError("'from' date cannot be after 'to' date", 400);
    }

    const result = await quotationsService.listQuotations(
      req.businessId!,
      query,
    );

    return res.json({
      success: true,
      ...result,
    });
  }),
);

/**
 * POST /quotations
 * Create a quotation without changing inventory or recording a sale.
 */
router.post(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const input = createQuotationSchema.parse(req.body);

    const data = await quotationsService.createQuotation(
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
 * GET /quotations/:id
 * Fetch a quotation within the authenticated business.
 */
router.get(
  "/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await quotationsService.getQuotationById(
      req.businessId!,
      String(req.params.id),
    );

    return res.json({
      success: true,
      data,
    });
  }),
);

/**
 * PATCH /quotations/:id/status
 * Change quotation status while enforcing service-level rules.
 */
router.patch(
  "/:id/status",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { status } = updateStatusSchema.parse(req.body);

    const data = await quotationsService.updateQuotationStatus(
      req.businessId!,
      String(req.params.id),
      status,
    );

    return res.json({
      success: true,
      data,
    });
  }),
);

export default router;