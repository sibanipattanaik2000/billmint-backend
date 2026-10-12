import { Router, Response } from "express";
import { z } from "zod";

import { authenticate, AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import * as deliveryChallansService from "../services/delivery-challans.service";
import { paginationSchema } from "../validators/common";

const router = Router();

const createDeliveryChallanSchema = z.object({
  customerId: z.string().trim().min(1).nullable().optional(),
  date: z.coerce.date().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
  transportInfo: z.string().trim().max(1000).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  items: z
    .array(
      z.object({
        itemId: z.string().trim().min(1).nullable().optional(),
        itemName: z.string().trim().max(255).optional(),
        quantity: z.coerce.number().positive().finite(),
        unit: z.string().trim().max(50).nullable().optional(),
        notes: z.string().trim().max(1000).nullable().optional(),
      }),
    )
    .min(1)
    .max(100),
});

function parseOptionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined) return undefined;

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${field}`);
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${field}`);
  }

  return parsed;
}

/**
 * GET /delivery-challans
 */
router.get(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const pagination = paginationSchema.parse(req.query);

    const from = parseOptionalDate(req.query.from, "from date");
    const to = parseOptionalDate(req.query.to, "to date");

    if (from && to && from > to) {
      return res.status(400).json({
        success: false,
        message: "'from' date cannot be after 'to' date",
      });
    }

    const result = await deliveryChallansService.listDeliveryChallans(
      req.businessId!,
      {
        page: pagination.page,
        limit: pagination.limit,
        search: pagination.search,
        from,
        to,
      },
    );

    return res.json({
      success: true,
      ...result,
    });
  }),
);

/**
 * POST /delivery-challans
 */
router.post(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = createDeliveryChallanSchema.parse(req.body);

    const result = await deliveryChallansService.createDeliveryChallan(
      req.businessId!,
      body,
    );

    return res.status(201).json({
      success: true,
      data: result,
    });
  }),
);

/**
 * GET /delivery-challans/:id
 */
router.get(
  "/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await deliveryChallansService.getDeliveryChallanById(
      req.businessId!,
      String(req.params.id),
    );

    return res.json({
      success: true,
      data: result,
    });
  }),
);

export default router;