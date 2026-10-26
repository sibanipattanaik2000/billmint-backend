import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { registerSchema, loginSchema, changePasswordSchema } from '../validators/auth';
import * as authService from '../services/auth.service';
import { setAuthCookie, clearAuthCookie } from '../utils/auth';

export const register = asyncHandler(async (req: AuthRequest, res: Response) => {
  const data = registerSchema.parse(req.body);
  const result = await authService.registerBusiness(data);
  setAuthCookie(res, result.token);
  res.status(201).json({ success: true, data: result });
});

export const login = asyncHandler(async (req: AuthRequest, res: Response) => {
  const data = loginSchema.parse(req.body);
  const ip = req.ip || req.socket.remoteAddress;
  const result = await authService.loginUser(
    data.userId,
    data.password,
    data.storeCode,
    ip,
  );  setAuthCookie(res, result.token);
  res.json({ success: true, data: result });
});

export const logout = asyncHandler(async (_req: AuthRequest, res: Response) => {
  clearAuthCookie(res);
  res.json({ success: true, message: 'Logged out successfully' });
});

export const me = asyncHandler(async (req: AuthRequest, res: Response) => {
  const result = await authService.getMe(req.user!.userId, req.user!.businessId);
  res.json({ success: true, data: result });
});

export const changePassword = asyncHandler(async (req: AuthRequest, res: Response) => {
  const data = changePasswordSchema.parse(req.body);
  const result = await authService.changePassword(
    req.user!.userId,
    data.currentPassword,
    data.newPassword
  );
  res.json({ success: true, data: result });
});
