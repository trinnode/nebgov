export function Skeleton({ className }: { className?: string }) {
  return (
    <div 
      className={`animate-pulse bg-gray-200 dark:bg-gray-700 rounded ${className}`}
      aria-busy="true"
      aria-label="Loading content"
    />
  );
}
