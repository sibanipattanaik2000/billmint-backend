import { Router, type Response } from "express";
import { z } from "zod";

import { authenticate, type AuthRequest } from "../middleware/auth";
import { asyncHandler, AppError } from "../middleware/errorHandler";
import * as bankAccountsService from "../services/bank-accounts.service";

const router = Router();

const createBankAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(150),
    accountNumber: z.string().trim().max(100).nullable().optional(),
    ifsc: z.string().trim().max(11).nullable().optional(),
    bankName: z.string().trim().max(150).nullable().optional(),
    branch: z.string().trim().max(150).nullable().optional(),
    openingBalance: z.coerce.number().finite().min(0).default(0),
    isCash: z.boolean().default(false),
  })
  .strict();

const listBankAccountsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional(),
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
});

/**
 * GET /cash-bank
 * List cash and bank accounts for the authenticated business.
 */
router.get(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = listBankAccountsQuerySchema.parse(req.query);

    const result = await bankAccountsService.listBankAccounts(
      req.businessId!,
      query,
    );

    return res.status(200).json({
      success: true,
      ...result,
    });
  }),
);

/**
 * GET /cash-bank/:id
 * Retrieve one account belonging to the authenticated business.
 */
router.get(
  "/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const accountId = String(req.params.id);

    const data = await bankAccountsService.getBankAccount(
      req.businessId!,
      accountId,
    );

    return res.status(200).json({
      success: true,
      data,
    });
  }),
);

/**
 * POST /cash-bank
 * Create a cash or bank account.
 */
router.post(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const input = createBankAccountSchema.parse(req.body);

    if (
      input.isCash &&
      (input.accountNumber || input.ifsc || input.bankName || input.branch)
    ) {
      throw new AppError(
        "Cash accounts cannot contain bank account details",
        400,
      );
    }

    const data = await bankAccountsService.createBankAccount(
      req.businessId!,
      input,
    );

    return res.status(201).json({
      success: true,
      data,
    });
  }),
);

export default router;