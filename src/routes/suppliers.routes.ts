
import { Router, Response } from "express";

import {
  authenticate,
  AuthRequest,
} from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import * as suppliersService from "../services/suppliers.service";
import {
  paginationSchema,
  supplierSchema,
} from "../validators/common";

const router = Router();

/**
 * GET /api/suppliers
 *
 * Returns suppliers scoped to the authenticated business.
 * Supports pagination, search, and status filtering.
 */
router.get(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = paginationSchema.parse(req.query);

    const rawStatus =
      typeof req.query.status === "string"
        ? req.query.status.trim().toUpperCase()
        : undefined;

    if (
      rawStatus &&
      rawStatus !== "ACTIVE" &&
      rawStatus !== "ARCHIVED"
    ) {
      return res.status(400).json({
        success: false,
        message: "Status must be ACTIVE or ARCHIVED",
      });
    }

    const result = await suppliersService.listSuppliers(
      req.businessId!,
      {
        page: query.page,
        limit: query.limit,
        search: query.search,
        status: rawStatus,
      },
    );

    return res.status(200).json({
      success: true,
      ...result,
    });
  }),
);

/**
 * POST /api/suppliers
 *
 * Creates a supplier and records the existing service's
 * audit log and opening balance transaction.
 */
router.post(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = supplierSchema.parse(req.body);

    const supplier = await suppliersService.createSupplier(
      req.businessId!,
      body,
      req.user?.userId,
    );

    return res.status(201).json({
      success: true,
      data: supplier,
    });
  }),
);

/**
 * GET /api/suppliers/:id
 */
router.get(
  "/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const supplier = await suppliersService.getSupplier(
      req.businessId!,
      String(req.params.id),
    );

    return res.status(200).json({
      success: true,
      data: supplier,
    });
  }),
);

/**
 * PATCH /api/suppliers/:id
 *
 * Opening balances cannot be changed through this endpoint.
 * They require a dedicated accounting adjustment.
 */
router.patch(
  "/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const schema = supplierSchema
      .partial()
      .omit({ openingBalance: true });

    const body = schema.parse(req.body);

    if (Object.keys(body).length === 0) {
      return res.status(400).json({
        success: false,
        message: "Provide at least one supplier field to update",
      });
    }

    const supplier = await suppliersService.updateSupplier(
      req.businessId!,
      String(req.params.id),
      body,
      req.user?.userId,
    );

    return res.status(200).json({
      success: true,
      data: supplier,
    });
  }),
);

/**
 * DELETE /api/suppliers/:id
 *
 * The service archives suppliers so existing accounting
 * records are preserved.
 */
router.delete(
  "/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await suppliersService.deleteSupplier(
      req.businessId!,
      String(req.params.id),
      req.user?.userId,
    );

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),
);

export default router;
