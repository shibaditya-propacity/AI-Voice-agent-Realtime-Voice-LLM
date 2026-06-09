'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useState } from 'react';
import { registerSchema, type RegisterInput } from '@saas/shared';
import { ROUTES } from '@saas/config';
import { useAuth } from '../hooks/useAuth';

export function RegisterForm() {
  const { register: registerUser } = useAuth();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({ resolver: zodResolver(registerSchema) });

  async function onSubmit(data: RegisterInput) {
    setServerError(null);
    try {
      await registerUser(data);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Something went wrong');
    }
  }

  const inputClass = (hasError: boolean) =>
    [
      'w-full rounded-lg border px-3.5 py-2.5 text-sm text-gray-900 shadow-sm',
      'placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-offset-0',
      hasError
        ? 'border-red-400 focus:border-red-400 focus:ring-red-200'
        : 'border-gray-300 focus:border-indigo-400 focus:ring-indigo-100',
    ].join(' ');

  return (
    <div className="space-y-8">
      <div>
        <div className="mb-6 flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center">
            <span className="text-white font-bold text-sm">P</span>
          </div>
          <span className="font-semibold text-gray-900 text-lg">Propacity</span>
        </div>
        <h1 className="text-2xl font-semibold text-gray-900">Create your account</h1>
        <p className="mt-1.5 text-sm text-gray-500">Start your free trial — no credit card required</p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        {serverError && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3">
            <p className="text-sm text-red-700">{serverError}</p>
          </div>
        )}

        <div className="space-y-1.5">
          <label htmlFor="name" className="block text-sm font-medium text-gray-700">Full name</label>
          <input id="name" type="text" autoComplete="name" placeholder="Your full name" {...register('name')} className={inputClass(!!errors.name)} />
          {errors.name && <p className="text-xs text-red-600">{errors.name.message}</p>}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="email" className="block text-sm font-medium text-gray-700">Work email</label>
          <input id="email" type="email" autoComplete="email" placeholder="you@company.com" {...register('email')} className={inputClass(!!errors.email)} />
          {errors.email && <p className="text-xs text-red-600">{errors.email.message}</p>}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="password" className="block text-sm font-medium text-gray-700">Password</label>
          <input id="password" type="password" autoComplete="new-password" placeholder="Min 8 chars, 1 uppercase, 1 number" {...register('password')} className={inputClass(!!errors.password)} />
          {errors.password && <p className="text-xs text-red-600">{errors.password.message}</p>}
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isSubmitting && (
            <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </button>

        <p className="text-xs text-gray-500 text-center">
          By creating an account, you agree to our{' '}
          <a href="#" className="text-indigo-600 hover:underline">Terms</a> and{' '}
          <a href="#" className="text-indigo-600 hover:underline">Privacy Policy</a>.
        </p>
      </form>

      <p className="text-center text-sm text-gray-500">
        Already have an account?{' '}
        <Link href={ROUTES.LOGIN} className="font-medium text-indigo-600 hover:text-indigo-700">
          Sign in
        </Link>
      </p>
    </div>
  );
}
