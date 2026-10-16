
import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import prisma from '../utils/prisma';

const router = Router();

const businessUpdateSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  ownerName: z.string().trim().min(1).max(150).optional(),
  email: z.string().trim().email().nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  gstin: z
    .string()
    .trim()
    .max(15)
    .nullable()
    .optional(),
  address: z.string().trim().max(500).nullable().optional(),
  state: z.string().trim().max(100).nullable().optional(),
  financialYearStart: z.number().int().min(1).max(12).optional(),
});

const settingsUpdateSchema = z.object({
  invoicePrefix: z.string().trim().min(1).max(20).optional(),
  invoiceNextNumber: z.number().int().min(1).max(2147483647).optional(),
  quotationPrefix: z.string().trim().min(1).max(20).optional(),
  quotationNextNumber: z.number().int().min(1).max(2147483647).optional(),
  challanPrefix: z.string().trim().min(1).max(20).optional(),
  challanNextNumber: z.number().int().min(1).max(2147483647).optional(),
  purchasePrefix: z.string().trim().min(1).max(20).optional(),
  purchaseNextNumber: z.number().int().min(1).max(2147483647).optional(),
  defaultTaxRate: z.number().min(0).max(100).optional(),
  currency: z.string().trim().length(3).optional(),
  currencySymbol: z.string().trim().min(1).max(10).optional(),
  decimalPlaces: z.number().int().min(0).max(4).optional(),
  termsAndConditions: z.string().max(5000).nullable().optional(),
  bankName: z.string().trim().max(150).nullable().optional(),
  bankAccountNumber: z.string().trim().max(50).nullable().optional(),
  bankIfsc: z.string().trim().max(20).nullable().optional(),
  bankBranch: z.string().trim().max(150).nullable().optional(),
  upiId: z.string().trim().max(100).nullable().optional(),
  invoiceTemplate: z
    .enum(['standard', 'modern', 'classic'])
    .optional(),
});

const updateSchema = z.object({
  business: businessUpdateSchema.optional(),
  settings: settingsUpdateSchema.optional(),
});

function sendValidationError(
  res: Response,
  message: string,
  details?: unknown,
) {
  return res.status(400).json({
    success: false,
    message,
    errors: details,
  });
}

/**
 * GET /business-settings
 * Returns company profile and accounting settings for the
 * authenticated business.
 */
router.get(
  '/',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const businessId = req.businessId!;

    const [business, settings] = await Promise.all([
      prisma.business.findFirst({
        where: {
          id: businessId,
          deletedAt: null,
        },
        select: {
          id: true,
          name: true,
          ownerName: true,
          email: true,
          phone: true,
          gstin: true,
          pan: true,
          address: true,
          city: true,
          state: true,
          pinCode: true,
          country: true,
          financialYearStart: true,
          logoUrl: true,
          signatureUrl: true,
          updatedAt: true,
        },
      }),
      prisma.businessSettings.findUnique({
        where: { businessId },
      }),
    ]);

    if (!business) {
      res.status(404).json({
        success: false,
        message: 'Business not found.',
      });
      return;
    }

    res.json({
      success: true,
      data: {
        business,
        settings:
          settings ?? {
            invoicePrefix: 'INV',
            invoiceNextNumber: 1,
            quotationPrefix: 'QT',
            quotationNextNumber: 1,
            challanPrefix: 'DC',
            challanNextNumber: 1,
            purchasePrefix: 'PUR',
            purchaseNextNumber: 1,
            defaultTaxRate: 18,
            currency: 'INR',
            currencySymbol: '₹',
            decimalPlaces: 2,
            termsAndConditions: null,
            bankName: null,
            bankAccountNumber: null,
            bankIfsc: null,
            bankBranch: null,
            upiId: null,
            invoiceTemplate: 'standard',
          },
      },
    });
  }),
);

/**
 * PATCH /business-settings
 * Updates only fields supplied by the authenticated business owner.
 */
router.patch(
  '/',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user?.isOwner) {
      res.status(403).json({
        success: false,
        message: 'Only the business owner can update business settings.',
      });
      return;
    }

    const parsed = updateSchema.safeParse(req.body);

    if (!parsed.success) {
      sendValidationError(
        res,
        'Please correct the invalid settings fields.',
        parsed.error.flatten(),
      );
      return;
    }

    const { business, settings } = parsed.data;

    if (
      (!business || Object.keys(business).length === 0) &&
      (!settings || Object.keys(settings).length === 0)
    ) {
      sendValidationError(
        res,
        'Provide at least one setting to update.',
      );
      return;
    }

    const businessId = req.businessId!;

    const updated = await prisma.$transaction(async (tx) => {
      const existingBusiness = await tx.business.findFirst({
        where: {
          id: businessId,
          deletedAt: null,
        },
        select: { id: true },
      });

      if (!existingBusiness) {
        throw new Error('BUSINESS_NOT_FOUND');
      }

      if (business && Object.keys(business).length > 0) {
        await tx.business.update({
          where: { id: businessId },
          data: business,
        });
      }

      if (settings && Object.keys(settings).length > 0) {
        await tx.businessSettings.upsert({
          where: { businessId },
          create: {
            businessId,
            ...settings,
          },
          update: settings,
        });
      }

      const [updatedBusiness, updatedSettings] = await Promise.all([
        tx.business.findUnique({
          where: { id: businessId },
          select: {
            id: true,
            name: true,
            ownerName: true,
            email: true,
            phone: true,
            gstin: true,
            pan: true,
            address: true,
            city: true,
            state: true,
            pinCode: true,
            country: true,
            financialYearStart: true,
            logoUrl: true,
            signatureUrl: true,
            updatedAt: true,
          },
        }),
        tx.businessSettings.findUnique({
          where: { businessId },
        }),
      ]);

      return {
        business: updatedBusiness,
        settings: updatedSettings,
      };
    });

    res.json({
      success: true,
      message: 'Business settings updated successfully.',
      data: updated,
    });
  }),
);

export default router;
