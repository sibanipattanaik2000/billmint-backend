import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import * as businessAccessService from "../services/business-access.service";
import { createBusinessForUser } from "../services/business-creation.service";
import { setAuthCookie } from "../utils/auth";

export const myBusinesses = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const businesses = await businessAccessService.getMyBusinesses(
      req.user!.userId,
      req.user!.businessId,
    );

    res.json({
      success: true,
      data: businesses,
    });
  },
);

export const switchBusiness = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const businessId = String(req.body?.businessId ?? "").trim();

    const result = await businessAccessService.switchBusiness(
      req.user!,
      businessId,
    );

    setAuthCookie(res, result.token);

    res.json({
      success: true,
      message: "Company switched successfully",
      data: {
        business: result.business,
      },
    });
  },
);

export const createBusiness = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const result = await createBusinessForUser(
      req.user!.userId,
      req.body,
    );

    // The newly created company becomes the active company.
    setAuthCookie(res, result.token);

    res.status(201).json({
      success: true,
      message: "Company created successfully",
      data: {
        business: result.business,
      },
    });
  },
);