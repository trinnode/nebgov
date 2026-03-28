import { Skeleton } from "./Skeleton";

export function VoteCountSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Skeleton className="h-4 w-12" />
        <div className="flex-1 bg-gray-100 rounded-full h-2">
          <Skeleton className="h-2 rounded-full w-3/4" />
        </div>
        <Skeleton className="h-4 w-16" />
      </div>
      <div className="flex items-center gap-3">
        <Skeleton className="h-4 w-16" />
        <div className="flex-1 bg-gray-100 rounded-full h-2">
          <Skeleton className="h-2 rounded-full w-1/4" />
        </div>
        <Skeleton className="h-4 w-16" />
      </div>
      <div className="flex items-center gap-3">
        <Skeleton className="h-4 w-14" />
        <div className="flex-1 bg-gray-100 rounded-full h-2">
          <Skeleton className="h-2 rounded-full w-1/6" />
        </div>
        <Skeleton className="h-4 w-16" />
      </div>
    </div>
  );
}
