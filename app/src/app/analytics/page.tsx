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
import { useTheme } from "../../hooks/useTheme";

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
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const chartTheme = {
    textColor: isDark ? "#94a3b8" : "#64748b",
    gridColor: isDark ? "#374151" : "#e5e7eb",
    tooltipBg: isDark ? "#1f2937" : "#ffffff",
    tooltipBorder: isDark ? "#374151" : "#e5e7eb",
  };
  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Analytics</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">Participation and voting trends.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">Total proposals</p>
          <p className="text-2xl font-semibold text-gray-900 dark:text-white">{stats.total}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">Avg participation</p>
          <p className="text-2xl font-semibold text-gray-900 dark:text-white">{stats.avgParticipation}%</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">Delegation rate</p>
          <p className="text-2xl font-semibold text-gray-900 dark:text-white">{stats.delegationRate}%</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">Passed proposals</p>
          <p className="text-2xl font-semibold text-gray-900 dark:text-white">{stats.passed}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-4">Participation Over Time</h3>
          <div style={{ width: "100%", height: 240 }}>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={participationData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <XAxis dataKey="date" tick={{ fill: chartTheme.textColor }} axisLine={{ stroke: chartTheme.gridColor }} tickLine={{ stroke: chartTheme.gridColor }} />
                <YAxis tick={{ fill: chartTheme.textColor }} axisLine={{ stroke: chartTheme.gridColor }} tickLine={{ stroke: chartTheme.gridColor }} />
                <Tooltip 
                  contentStyle={{ backgroundColor: chartTheme.tooltipBg, borderColor: chartTheme.tooltipBorder, color: isDark ? '#fff' : '#000' }}
                  itemStyle={{ color: isDark ? '#fff' : '#000' }}
                />
                <Line type="monotone" dataKey="votes" stroke="#6366f1" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-4">Proposal Outcomes</h3>
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={outcomeData} dataKey="value" nameKey="name" innerRadius={40} outerRadius={80} paddingAngle={4}>
                  {outcomeData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip 
                  contentStyle={{ backgroundColor: chartTheme.tooltipBg, borderColor: chartTheme.tooltipBorder, color: isDark ? '#fff' : '#000' }}
                  itemStyle={{ color: isDark ? '#fff' : '#000' }}
                />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="lg:col-span-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-4">Top Delegates (by votes)</h3>
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={topDelegates} layout="vertical" margin={{ top: 5, right: 30, left: 50, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridColor} />
                <XAxis type="number" tick={{ fill: chartTheme.textColor }} axisLine={{ stroke: chartTheme.gridColor }} tickLine={{ stroke: chartTheme.gridColor }} />
                <YAxis type="category" dataKey="name" width={120} tick={{ fill: chartTheme.textColor }} axisLine={{ stroke: chartTheme.gridColor }} tickLine={{ stroke: chartTheme.gridColor }} />
                <Tooltip 
                  contentStyle={{ backgroundColor: chartTheme.tooltipBg, borderColor: chartTheme.tooltipBorder, color: isDark ? '#fff' : '#000' }}
                  itemStyle={{ color: isDark ? '#fff' : '#000' }}
                />
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
