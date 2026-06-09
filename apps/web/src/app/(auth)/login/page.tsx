import { LoginForm } from '@/features/auth/components/LoginForm';
import { AuthBanner } from '@/components/layout/AuthBanner';

export default function LoginPage() {
  return (
    <div className="flex h-screen w-full">
      <AuthBanner />
      <div className="flex flex-1 flex-col justify-center px-8 py-12 lg:px-16 xl:px-24 overflow-y-auto">
        <div className="mx-auto w-full max-w-sm">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
