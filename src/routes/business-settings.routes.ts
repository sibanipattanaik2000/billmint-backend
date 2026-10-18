
import { Router } from "express";
import { z } from "zod";
import prisma from "../utils/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { asyncHandler, AppError } from "../middleware/errorHandler";

const router = Router();

const nullableText = (maxLength: number) =>
  z.union([
    z.string().trim().max(maxLength),
    z.null(),
  ]).optional();

const businessSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  ownerName: z.string().trim().min(1).max(150).optional(),
  email: nullableText(254),
  phone: nullableText(30),
  gstin: nullableText(15),
  address: nullableText(1000),
  city: nullableText(100),
  state: nullableText(100),
  financialYearStart: z.number().int().min(1).max(12).optional(),
}).strict();

const settingsSchema = z.object({
  invoicePrefix: z.string().trim().min(1).max(20).optional(),
  invoiceNextNumber: z.number().int().min(1).max(2_000_000_000).optional(),
  quotationPrefix: z.string().trim().min(1).max(20).optional(),
  quotationNextNumber: z.number().int().min(1).max(2_000_000_000).optional(),
  challanPrefix: z.string().trim().min(1).max(20).optional(),
  challanNextNumber: z.number().int().min(1).max(2_000_000_000).optional(),
  purchasePrefix: z.string().trim().min(1).max(20).optional(),
  purchaseNextNumber: z.number().int().min(1).max(2_000_000_000).optional(),
  defaultTaxRate: z.number().min(0).max(100).optional(),
  currency: z.enum(["INR", "USD"]).optional(),
  currencySymbol: z.string().trim().min(1).max(5).optional(),
  decimalPlaces: z.number().int().min(0).max(4).optional(),
  termsAndConditions: nullableText(10000),
  bankName: nullableText(150),
  bankAccountNumber: nullableText(50),
  bankIfsc: nullableText(20),
  bankBranch: nullableText(150),
  upiId: nullableText(150),
  invoiceTemplate: z.enum(["standard", "thermal", "modern"]).optional(),
}).strict();

const updateSchema = z.object({
  business: businessSchema.optional(),
  settings: settingsSchema.optional(),
}).strict().refine(
  (value) => Boolean(value.business || value.settings),
  { message: "Provide business fields or settings to update." },
);

async function requireBusinessOwner(req: AuthRequest) {
  if (!req.businessId || !req.user?.userId || !req.user?.memberId) {
    throw new AppError("Authentication required", 401);
  }

  const member = await prisma.businessMember.findFirst({
    where: {
      id: req.user.memberId,
      businessId: req.businessId,
      userId: req.user.userId,
      status: "ACTIVE",
      isOwner: true,
    },
    select: { id: true },
  });

  if (!member) {
    throw new AppError(
      "Only the business owner can change business settings.",
      403,
    );
  }
}

router.get(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const businessId = req.businessId!;

    const business = await prisma.business.findFirst({
      where: {
        id: businessId,
        deletedAt: null,
      },
      include: {
        settings: true,
      },
    });

    if (!business) {
      throw new AppError("Business not found.", 404);
    }

    let settings = business.settings;

    if (!settings) {
      settings = await prisma.businessSettings.upsert({
        where: { businessId },
        update: {},
        create: { businessId },
      });
    }

    res.json({
      success: true,
      data: {
        business: {
          id: business.id,
          name: business.name,
          ownerName: business.ownerName,
          email: business.email,
          phone: business.phone,
          gstin: business.gstin,
          pan: business.pan,
          address: business.address,
          city: business.city,
          state: business.state,
          pinCode: business.pinCode,
          country: business.country,
          financialYearStart: business.financialYearStart,
          logoUrl: business.logoUrl,
          signatureUrl: business.signatureUrl,
          updatedAt: business.updatedAt,
        },
        settings,
      },
    });
  }),
);

router.patch(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    await requireBusinessOwner(req);

    const parsed = updateSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new AppError(
        parsed.error.issues
          .map((issue) => issue.message)
          .join(", "),
        400,
      );
    }

    const businessId = req.businessId!;
    const { business: businessInput, settings: settingsInput } =
      parsed.data;

    const result = await prisma.$transaction(async (tx) => {
      if (businessInput) {
        const existingBusiness = await tx.business.findFirst({
          where: {
            id: businessId,
            deletedAt: null,
          },
          select: { id: true },
        });

        if (!existingBusiness) {
          throw new AppError("Business not found.", 404);
        }

        await tx.business.update({
          where: { id: businessId },
          data: businessInput,
        });
      }

      if (settingsInput) {
        await tx.businessSettings.upsert({
          where: { businessId },
          update: settingsInput,
          create: {
            businessId,
            ...settingsInput,
          },
        });
      }

      const updatedBusiness = await tx.business.findFirst({
        where: {
          id: businessId,
          deletedAt: null,
        },
        include: {
          settings: true,
        },
      });

      if (!updatedBusiness || !updatedBusiness.settings) {
        throw new AppError(
          "Unable to load saved business settings.",
          500,
        );
      }

      return {
        business: {
          id: updatedBusiness.id,
          name: updatedBusiness.name,
          ownerName: updatedBusiness.ownerName,
          email: updatedBusiness.email,
          phone: updatedBusiness.phone,
          gstin: updatedBusiness.gstin,
          pan: updatedBusiness.pan,
          address: updatedBusiness.address,
          city: updatedBusiness.city,
          state: updatedBusiness.state,
          pinCode: updatedBusiness.pinCode,
          country: updatedBusiness.country,
          financialYearStart: updatedBusiness.financialYearStart,
          logoUrl: updatedBusiness.logoUrl,
          signatureUrl: updatedBusiness.signatureUrl,
          updatedAt: updatedBusiness.updatedAt,
        },
        settings: updatedBusiness.settings,
      };
    });

    res.json({
      success: true,
      message: "Business settings saved successfully.",
      data: result,
    });
  }),
);

export default router;
