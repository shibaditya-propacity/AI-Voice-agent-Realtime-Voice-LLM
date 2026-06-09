'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useState } from 'react';
import { forgotPasswordSchema, type ForgotPasswordInput } from '@saas/shared';
import { ROUTES } from '@saas/config';

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({ resolver: zodResolver(forgotPasswordSchema) });

  async function onSubmit(_data: ForgotPasswordInput) {
    await new Promise((r) => setTimeout(r, 1000)); // UI demo only
    setSent(true);
  }

  return (
    <div className="space-y-8">
      <div>
        <div className="mb-6 flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center">
            <span className="text-white font-bold text-sm">P</span>
          </div>
          <span className="font-semibold text-gray-900 text-lg">Propacity</span>
        </div>
        <h1 className="text-2xl font-semibold text-gray-900">Reset your password</h1>
        <p className="mt-1.5 text-sm text-gray-500">
          Enter your email and we&apos;ll send you a reset link.
        </p>
      </div>

      {sent ? (
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-4 space-y-1">
          <p className="text-sm font-medium text-emerald-800">Check your inbox</p>
          <p className="text-sm text-emerald-700">
            If an account exists, you&apos;ll receive a password reset email shortly.
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
          <div className="space-y-1.5">
            <label htmlFor="email" className="block text-sm font-medium text-gray-700">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              {...register('email')}
              className={[
                'w-full rounded-lg border px-3.5 py-2.5 text-sm text-gray-900 shadow-sm',
                'placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-offset-0',
                errors.email
                  ? 'border-red-400 focus:border-red-400 focus:ring-red-200'
                  : 'border-gray-300 focus:border-indigo-400 focus:ring-indigo-100',
              ].join(' ')}
            />
            {errors.email && <p className="text-xs text-red-600">{errors.email.message}</p>}
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
            {isSubmitting ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}

      <p className="text-center text-sm text-gray-500">
        <Link href={ROUTES.LOGIN} className="font-medium text-indigo-600 hover:text-indigo-700">
          ← Back to sign in
        </Link>
      </p>
    </div>
  );
}
