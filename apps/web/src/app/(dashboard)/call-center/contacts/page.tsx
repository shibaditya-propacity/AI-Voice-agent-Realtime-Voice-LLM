'use client';

import { useState, useRef, useCallback } from 'react';
import {
  UserPlus, Upload, Phone, Trash2, Search, ChevronLeft, ChevronRight,
} from 'lucide-react';
import {
  useContacts, useCreateContact, useImportContacts,
  useDeleteContact, useTriggerCall,
} from '@/features/call-center/hooks/useCallCenter';
import type { Contact } from '@/features/call-center/api/callCenterApi';

// ─── Add Contact Modal ────────────────────────────────────────────────────────

function AddContactModal({ onClose }: { onClose: () => void }) {
  const { mutateAsync, isPending } = useCreateContact();
  const [form, setForm] = useState({ name: '', phone: '', email: '', project: '', notes: '' });
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.name.trim() || !form.phone.trim()) {
      setError('Name and phone are required');
      return;
    }
    try {
      await mutateAsync({
        name: form.name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim() || undefined,
        project: form.project.trim() || undefined,
        notes: form.notes.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Add Contact</h2>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="Full name" />
            <Field label="Phone *" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} placeholder="+91 98765..." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} placeholder="email@example.com" />
            <Field label="Company" value={form.project} onChange={(v) => setForm({ ...form, project: v })} placeholder="Company name" />
          </div>
          <Field label="Notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} placeholder="Optional notes" />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {isPending ? 'Adding…' : 'Add Contact'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
      />
    </div>
  );
}

// ─── Import Modal ─────────────────────────────────────────────────────────────

function ImportModal({ onClose }: { onClose: () => void }) {
  const { mutateAsync, isPending } = useImportContacts();
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{ imported: number; errors: string[] } | null>(null);
  const [error, setError] = useState('');

  const handleFile = useCallback(async (file: File) => {
    setError('');
    setResult(null);
    try {
      // Dynamic import to avoid bundling xlsx unless needed
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws);
      const mapped = rows.map((r) => ({
        name: String(r['Name'] ?? r['name'] ?? r['Full Name'] ?? '').trim(),
        phone: String(r['Phone'] ?? r['phone'] ?? r['Mobile'] ?? r['mobile'] ?? '').trim(),
        email: String(r['Email'] ?? r['email'] ?? '').trim() || undefined,
        project: String(r['Company'] ?? r['project'] ?? '').trim() || undefined,
      })).filter((r) => r.phone);

      if (mapped.length === 0) {
        setError('No valid rows found. Ensure a "Phone" column exists.');
        return;
      }
      const res = await mutateAsync(mapped);
      setResult(res);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [mutateAsync]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Import Contacts</h2>
        <p className="text-xs text-gray-500 mb-4">Upload an Excel (.xlsx) or CSV file. Required column: <code>Phone</code>. Optional: <code>Name</code>, <code>Email</code>, <code>Company</code>.</p>

        {!result ? (
          <>
            <div
              onDrop={onDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => fileRef.current?.click()}
              className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/30 transition-colors"
            >
              <Upload className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-600">Drop file here or click to browse</p>
              <p className="text-xs text-gray-400 mt-1">.xlsx, .csv</p>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
            {isPending && <p className="text-sm text-indigo-600 mt-3 text-center">Importing…</p>}
            {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
          </>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 p-3 bg-green-50 rounded-lg">
              <CheckCircleIcon className="h-5 w-5 text-green-600 flex-shrink-0" />
              <p className="text-sm text-green-800">{result.imported} contact{result.imported !== 1 ? 's' : ''} imported</p>
            </div>
            {result.errors.length > 0 && (
              <div className="p-3 bg-yellow-50 rounded-lg">
                <p className="text-xs font-medium text-yellow-800 mb-1">{result.errors.length} row(s) skipped:</p>
                <ul className="text-xs text-yellow-700 space-y-0.5 list-disc pl-4">
                  {result.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}
                  {result.errors.length > 5 && <li>…and {result.errors.length - 5} more</li>}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end mt-4">
          <button onClick={onClose} className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
            {result ? 'Done' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

// ─── Contact Row ──────────────────────────────────────────────────────────────

function ContactRow({ contact }: { contact: Contact }) {
  const { mutate: deleteContact } = useDeleteContact();
  const { mutate: triggerCall, isPending: calling } = useTriggerCall();
  const [callStatus, setCallStatus] = useState<'idle' | 'dialing' | 'failed'>('idle');

  const handleCall = () => {
    setCallStatus('dialing');
    triggerCall(
      { contactId: contact.id },
      {
        onSuccess: () => setCallStatus('idle'),
        onError: () => setCallStatus('failed'),
        onSettled: () => setTimeout(() => setCallStatus('idle'), 3000),
      },
    );
  };

  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-4 py-3">
        <div className="font-medium text-sm text-gray-900">{contact.name}</div>
        {contact.project && <div className="text-xs text-gray-400">{contact.project}</div>}
      </td>
      <td className="px-4 py-3 text-sm text-gray-600">{contact.phone}</td>
      <td className="px-4 py-3 text-sm text-gray-500">{contact.email ?? '—'}</td>
      <td className="px-4 py-3 text-xs text-gray-400">
        {new Date(contact.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {callStatus === 'failed' && (
            <span className="text-xs text-red-500">Failed</span>
          )}
          {callStatus === 'dialing' && (
            <span className="text-xs text-indigo-500">Dialing…</span>
          )}
          <button
            onClick={handleCall}
            disabled={calling}
            title="Call now"
            className={`p-1.5 rounded-lg disabled:opacity-40 transition-colors ${
              callStatus === 'failed'
                ? 'text-red-500 hover:bg-red-50'
                : 'text-indigo-600 hover:bg-indigo-50'
            }`}
          >
            <Phone className="h-4 w-4" />
          </button>
          <button
            onClick={() => { if (confirm('Delete this contact?')) deleteContact(contact.id); }}
            title="Delete"
            className="p-1.5 rounded-lg text-red-400 hover:bg-red-50 transition-colors"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ContactsPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data, isLoading } = useContacts(page, debouncedSearch || undefined);

  const onSearch = (val: string) => {
    setSearch(val);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setDebouncedSearch(val);
      setPage(1);
    }, 300);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Contacts</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {data ? `${data.total.toLocaleString()} contact${data.total !== 1 ? 's' : ''}` : 'Loading…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <Upload className="h-4 w-4" />
            Import
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
          >
            <UserPlus className="h-4 w-4" />
            Add Contact
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search by name or phone…"
          className="w-full border border-gray-200 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
        />
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Name</th>
                <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Phone</th>
                <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Email</th>
                <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Added</th>
                <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400">Loading contacts…</td>
                </tr>
              ) : data?.contacts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center">
                    <p className="text-sm text-gray-500">No contacts yet</p>
                    <p className="text-xs text-gray-400 mt-1">Add contacts manually or import from Excel</p>
                  </td>
                </tr>
              ) : (
                data?.contacts.map((c) => <ContactRow key={c.id} contact={c} />)
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data && data.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
            <p className="text-xs text-gray-500">
              Page {data.page} of {data.pages}
            </p>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                onClick={() => setPage((p) => Math.min(data.pages, p + 1))}
                disabled={page === data.pages}
                className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {showAdd && <AddContactModal onClose={() => setShowAdd(false)} />}
      {showImport && <ImportModal onClose={() => setShowImport(false)} />}
    </div>
  );
}
