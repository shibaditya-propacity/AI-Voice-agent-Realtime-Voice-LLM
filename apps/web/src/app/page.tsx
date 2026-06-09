import { redirect } from 'next/navigation';
import { ROUTES } from '@saas/config';

export default function HomePage() {
  redirect(ROUTES.DASHBOARD);
}
