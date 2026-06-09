import { RegisterForm } from '@/features/auth/components/RegisterForm';
import { AuthBanner } from '@/components/layout/AuthBanner';

export default function RegisterPage() {
  return (
    <div className="flex h-screen w-full">
      <AuthBanner />
      <div className="flex flex-1 flex-col justify-center px-8 py-12 lg:px-16 xl:px-24 overflow-y-auto">
        <div className="mx-auto w-full max-w-sm">
          <RegisterForm />
        </div>
      </div>
    </div>
  );
}
