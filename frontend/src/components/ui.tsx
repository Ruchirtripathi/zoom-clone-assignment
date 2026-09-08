"use client";

import { Check, X } from "lucide-react";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 backdrop-blur-sm p-4"><div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden"><div className="flex justify-between items-center px-6 py-5 border-b border-slate-100"><div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#2f6fed]">Meetspace</p><h2 className="text-xl font-semibold tracking-[-0.03em] text-slate-950 mt-1">{title}</h2></div><button onClick={onClose} className="w-9 h-9 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 flex items-center justify-center" aria-label="Close dialog"><X className="w-5 h-5" /></button></div><div className="p-6">{children}</div></div></div>;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="block text-xs font-semibold text-slate-600 mb-2">{label}</span>{children}</label>;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <label className="flex items-center gap-3 text-sm text-slate-600 cursor-pointer"><button type="button" onClick={() => onChange(!checked)} className={`w-5 h-5 rounded-md border flex items-center justify-center transition-colors ${checked ? "bg-[#2f6fed] border-[#2f6fed] text-white" : "border-slate-300 bg-white"}`} aria-pressed={checked}>{checked && <Check className="w-3.5 h-3.5" />}</button>{label}</label>;
}
