import { Skeleton } from "./Skeleton";

export function TreasuryBalanceSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <Skeleton className="h-4 w-20 mb-2" />
        <Skeleton className="h-8 w-24 mt-1" />
      </div>
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <Skeleton className="h-4 w-16 mb-2" />
        <Skeleton className="h-8 w-28 mt-1" />
      </div>
    </div>
  );
}
