
import { Router, Response } from "express";
import { z } from "zod";

import { authenticate, AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import * as purchasesService from "../services/purchases.service";
import {
  paginationSchema,
  purchaseSchema,
} from "../validators/common";

const router = Router();

/**
 * Keep purchase validation local to this router.
 * The existing shared purchase schema does not include billNumber,
 * which is required by purchases.service.ts.
 */
const createPurchaseSchema = purchaseSchema.extend({
  billNumber: z.string().trim().min(1, "Bill number is required").max(100),
});

/**
 * GET /purchases
 * List purchases belonging to the authenticated business.
 */
router.get(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = paginationSchema.parse(req.query);

    const status =
      typeof req.query.status === "string"
        ? req.query.status.trim()
        : undefined;

    const from =
      typeof req.query.from === "string"
        ? new Date(req.query.from)
        : undefined;

    const to =
      typeof req.query.to === "string"
        ? new Date(req.query.to)
        : undefined;

    if (from && Number.isNaN(from.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid from date",
      });
    }

    if (to && Number.isNaN(to.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid to date",
      });
    }

    if (from && to && from > to) {
      return res.status(400).json({
        success: false,
        message: "'from' date cannot be after 'to' date",
      });
    }

    const data = await purchasesService.getPurchases(
      req.businessId!,
      {
        page: query.page,
        limit: query.limit,
        search: query.search,
        status,
        from,
        to,
      },
    );

    return res.json({
      success: true,
      ...data,
    });
  }),
);

/**
 * POST /purchases
 * Create a purchase and let the existing service handle
 * database transactions, totals, stock, and accounting updates.
 */
router.post(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = createPurchaseSchema.parse(req.body);

    const data = await purchasesService.createPurchase(
      req.businessId!,
      {
        ...body,
        createdById: req.user?.userId,
      },
    );

    return res.status(201).json({
      success: true,
      data,
    });
  }),
);

/**
 * GET /purchases/:id
 */
router.get(
  "/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const data = await purchasesService.getPurchaseById(
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
 * POST /purchases/:id/cancel
 */
router.post(
  "/:id/cancel",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const data = await purchasesService.cancelPurchase(
      req.businessId!,
      id,
      req.user?.userId,
    );

    return res.json({
      success: true,
      data,
    });
  }),
);

export default router;
