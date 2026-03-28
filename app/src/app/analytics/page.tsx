"use client";

import React from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  CartesianGrid,
  Legend,
} from "recharts";

const stats = {
  total: 124,
  passed: 78,
  failed: 32,
  pending: 14,
  avgParticipation: 12.4,
  delegationRate: 24.5,
};

const participationData = [
  { date: "Jan", votes: 10 },
  { date: "Feb", votes: 20 },
  { date: "Mar", votes: 14 },
  { date: "Apr", votes: 30 },
  { date: "May", votes: 22 },
  { date: "Jun", votes: 28 },
];

const outcomeData = [
  { name: "Passed", value: stats.passed },
  { name: "Failed", value: stats.failed },
  { name: "Pending", value: stats.pending },
];

const topDelegates = [
  { name: "Delegate A", votes: 120 },
  { name: "Delegate B", votes: 95 },
  { name: "Delegate C", votes: 78 },
  { name: "Delegate D", votes: 55 },
  { name: "Delegate E", votes: 40 },
];

const COLORS = ["#60a5fa", "#34d399", "#f97316", "#f87171", "#a78bfa"];

export default function AnalyticsPage() {
  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Analytics</h1>
          <p className="text-gray-500 mt-1">Participation and voting trends.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-sm text-gray-500">Total proposals</p>
          <p className="text-2xl font-semibold text-gray-900">{stats.total}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-sm text-gray-500">Avg participation</p>
          <p className="text-2xl font-semibold text-gray-900">{stats.avgParticipation}%</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-sm text-gray-500">Delegation rate</p>
          <p className="text-2xl font-semibold text-gray-900">{stats.delegationRate}%</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-sm text-gray-500">Passed proposals</p>
          <p className="text-2xl font-semibold text-gray-900">{stats.passed}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white border border-gray-200 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-600 mb-4">Participation Over Time</h3>
          <div style={{ width: "100%", height: 240 }}>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={participationData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="votes" stroke="#6366f1" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-600 mb-4">Proposal Outcomes</h3>
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={outcomeData} dataKey="value" nameKey="name" innerRadius={40} outerRadius={80} paddingAngle={4}>
                  {outcomeData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="lg:col-span-3 bg-white border border-gray-200 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-600 mb-4">Top Delegates (by votes)</h3>
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={topDelegates} layout="vertical" margin={{ top: 5, right: 30, left: 50, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" />
                <YAxis type="category" dataKey="name" width={120} />
                <Tooltip />
                <Bar dataKey="votes" fill="#60a5fa">
                  {topDelegates.map((_, idx) => (
                    <Cell key={`bar-${idx}`} fill={COLORS[idx % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
