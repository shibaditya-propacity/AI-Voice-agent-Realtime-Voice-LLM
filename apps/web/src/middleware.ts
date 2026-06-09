import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { TOKEN_KEYS, ROUTES } from '@saas/config';

const PUBLIC_PATHS = [ROUTES.LOGIN, ROUTES.REGISTER, ROUTES.FORGOT_PASSWORD];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(TOKEN_KEYS.ACCESS)?.value;

  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  if (!token && !isPublic && pathname !== '/') {
    return NextResponse.redirect(new URL(ROUTES.LOGIN, request.url));
  }

  if (token && isPublic) {
    return NextResponse.redirect(new URL(ROUTES.DASHBOARD, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
};
