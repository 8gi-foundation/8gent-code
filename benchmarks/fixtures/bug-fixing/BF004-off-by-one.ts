/**
 * Fixture: BF004 - Off-by-One Errors
 *
 * Bug: Multiple off-by-one errors in loop boundaries and array indexing
 * Task: Fix all off-by-one errors to make tests pass
 */

// BUG: Returns wrong range (missing last element)
export function range(start: number, end: number): number[] {
  const result: number[] = [];
  for (let i = start; i < end; i++) {
    result.push(i);
  }
  return result;
}
// Expected: range(1, 5) => [1, 2, 3, 4, 5]
// Actual: range(1, 5) => [1, 2, 3, 4]

// BUG: Accesses index out of bounds
export function getLastN<T>(arr: T[], n: number): T[] {
  const result: T[] = [];
  for (let i = arr.length - n; i <= arr.length; i++) {
    result.push(arr[i]);
  }
  return result;
}
// Expected: getLastN([1,2,3,4,5], 3) => [3, 4, 5]
// Actual: crashes with undefined

// BUG: Wrong pagination calculation
export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = page * pageSize;
  const end = start + pageSize;
  return items.slice(start, end);
}
// Expected: paginate([1,2,3,4,5], 1, 2) => [1, 2] (page 1)
// Actual: paginate([1,2,3,4,5], 1, 2) => [3, 4] (page 2)

// BUG: Wrong middle element for even-length arrays
export function findMiddle<T>(arr: T[]): T | T[] {
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 0) {
    return [arr[mid], arr[mid + 1]];
  }
  return arr[mid];
}
// Expected: findMiddle([1,2,3,4]) => [2, 3]
// Actual: findMiddle([1,2,3,4]) => [3, 4]

// BUG: Binary search finds wrong index
export function binarySearch(arr: number[], target: number): number {
  let left = 0;
  let right = arr.length;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (arr[mid] === target) {
      return mid;
    } else if (arr[mid] < target) {
      left = mid;
    } else {
      right = mid;
    }
  }

  return -1;
}
// BUG: Infinite loop when target not found

// Test function
export function runTests(): void {
  console.log("range(1, 5):", range(1, 5)); // Should be [1,2,3,4,5]
  console.log("getLastN([1,2,3,4,5], 3):", getLastN([1, 2, 3, 4, 5], 3)); // Should be [3,4,5]
  console.log("paginate([1,2,3,4,5], 1, 2):", paginate([1, 2, 3, 4, 5], 1, 2)); // Should be [1,2]
  console.log("findMiddle([1,2,3,4]):", findMiddle([1, 2, 3, 4])); // Should be [2,3]
  console.log("binarySearch([1,2,3,4,5], 3):", binarySearch([1, 2, 3, 4, 5], 3)); // Should be 2
}
