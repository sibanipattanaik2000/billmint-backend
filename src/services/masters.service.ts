import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";

/**
 * Item master data service.
 *
 * All master records are scoped to the authenticated business.
 * This prevents one business from reading or attaching another
 * business's units, categories, or brands.
 */

export type CreateUnitInput = {
  name: string;
  shortName: string;
};

export type CreateCategoryInput = {
  name: string;
  parentId?: string | null;
};

export type CreateBrandInput = {
  name: string;
};

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeShortName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/* =========================================================
   ITEM MASTERS
========================================================= */

export async function getItemMasters(businessId: string) {
  const [units, categories, brands] = await Promise.all([
    prisma.unit.findMany({
      where: {
        businessId,
      },
      orderBy: [
        { name: "asc" },
      ],
      select: {
        id: true,
        name: true,
        shortName: true,
      },
    }),

    prisma.itemCategory.findMany({
      where: {
        businessId,
      },
      orderBy: [
        { name: "asc" },
      ],
      select: {
        id: true,
        name: true,
        parentId: true,
      },
    }),

    prisma.brand.findMany({
      where: {
        businessId,
      },
      orderBy: [
        { name: "asc" },
      ],
      select: {
        id: true,
        name: true,
      },
    }),
  ]);

  return {
    units,
    categories,
    brands,
  };
}

/* =========================================================
   UNITS
========================================================= */

export async function listUnits(
  businessId: string,
  search?: string,
) {
  const normalizedSearch = search?.trim();

  return prisma.unit.findMany({
    where: {
      businessId,
      ...(normalizedSearch
        ? {
            OR: [
              {
                name: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
              {
                shortName: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
            ],
          }
        : {}),
    },
    orderBy: {
      name: "asc",
    },
    select: {
      id: true,
      name: true,
      shortName: true,
    },
  });
}

export async function createUnit(
  businessId: string,
  input: CreateUnitInput,
) {
  const name = normalizeName(input.name);
  const shortName = normalizeShortName(input.shortName);

  if (!name) {
    throw new AppError("Unit name is required", 400);
  }

  if (!shortName) {
    throw new AppError("Unit short name is required", 400);
  }

  if (name.length > 100) {
    throw new AppError(
      "Unit name cannot exceed 100 characters",
      400,
    );
  }

  if (shortName.length > 30) {
    throw new AppError(
      "Unit short name cannot exceed 30 characters",
      400,
    );
  }

  const existing = await prisma.unit.findFirst({
    where: {
      businessId,
      name: {
        equals: name,
        mode: "insensitive",
      },
    },
    select: {
      id: true,
    },
  });

  if (existing) {
    throw new AppError(
      "A unit with this name already exists",
      409,
    );
  }

  return prisma.unit.create({
    data: {
      businessId,
      name,
      shortName,
    },
    select: {
      id: true,
      name: true,
      shortName: true,
    },
  });
}

/* =========================================================
   CATEGORIES
========================================================= */

export async function listCategories(
  businessId: string,
  search?: string,
) {
  const normalizedSearch = search?.trim();

  return prisma.itemCategory.findMany({
    where: {
      businessId,
      ...(normalizedSearch
        ? {
            name: {
              contains: normalizedSearch,
              mode: "insensitive",
            },
          }
        : {}),
    },
    orderBy: {
      name: "asc",
    },
    select: {
      id: true,
      name: true,
      parentId: true,
    },
  });
}

export async function createCategory(
  businessId: string,
  input: CreateCategoryInput,
) {
  const name = normalizeName(input.name);
  const parentId = input.parentId?.trim() || null;

  if (!name) {
    throw new AppError(
      "Category name is required",
      400,
    );
  }

  if (name.length > 100) {
    throw new AppError(
      "Category name cannot exceed 100 characters",
      400,
    );
  }

  if (parentId) {
    const parent = await prisma.itemCategory.findFirst({
      where: {
        id: parentId,
        businessId,
      },
      select: {
        id: true,
      },
    });

    if (!parent) {
      throw new AppError(
        "Parent category not found",
        404,
      );
    }
  }

  const existing = await prisma.itemCategory.findFirst({
    where: {
      businessId,
      name: {
        equals: name,
        mode: "insensitive",
      },
    },
    select: {
      id: true,
    },
  });

  if (existing) {
    throw new AppError(
      "A category with this name already exists",
      409,
    );
  }

  return prisma.itemCategory.create({
    data: {
      businessId,
      name,
      parentId,
    },
    select: {
      id: true,
      name: true,
      parentId: true,
    },
  });
}

/* =========================================================
   BRANDS
========================================================= */

export async function listBrands(
  businessId: string,
  search?: string,
) {
  const normalizedSearch = search?.trim();

  return prisma.brand.findMany({
    where: {
      businessId,
      ...(normalizedSearch
        ? {
            name: {
              contains: normalizedSearch,
              mode: "insensitive",
            },
          }
        : {}),
    },
    orderBy: {
      name: "asc",
    },
    select: {
      id: true,
      name: true,
    },
  });
}

export async function createBrand(
  businessId: string,
  input: CreateBrandInput,
) {
  const name = normalizeName(input.name);

  if (!name) {
    throw new AppError(
      "Brand name is required",
      400,
    );
  }

  if (name.length > 100) {
    throw new AppError(
      "Brand name cannot exceed 100 characters",
      400,
    );
  }

  const existing = await prisma.brand.findFirst({
    where: {
      businessId,
      name: {
        equals: name,
        mode: "insensitive",
      },
    },
    select: {
      id: true,
    },
  });

  if (existing) {
    throw new AppError(
      "A brand with this name already exists",
      409,
    );
  }

  return prisma.brand.create({
    data: {
      businessId,
      name,
    },
    select: {
      id: true,
      name: true,
    },
  });
}