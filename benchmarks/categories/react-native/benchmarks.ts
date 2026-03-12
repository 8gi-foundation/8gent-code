/**
 * 8gent Code Benchmarks - React Native / Expo Mobile Development
 *
 * Tests mobile app development skills with React Native and Expo
 */

import type { BenchmarkDefinition } from "../../types";

export const reactNativeBenchmarks: BenchmarkDefinition[] = [
  {
    id: "RN001",
    name: "Create Animated List Component",
    category: "react-native",
    difficulty: "medium",
    description: "Build a performant animated FlatList with swipe-to-delete",
    task: `Create a React Native component that:
1. Uses FlatList with item separators
2. Implements swipe-to-delete with Reanimated
3. Shows a confirmation before deleting
4. Animates item removal smoothly
5. Handles empty state gracefully`,
    expectedBehavior: "List scrolls smoothly, items can be swiped and deleted with animation",
    fixture: "fixtures/react-native/RN001-list.tsx",
    rubric: {
      correctness: {
        weight: 40,
        criteria: [
          "FlatList renders items correctly",
          "Swipe gesture is detected",
          "Delete animation plays",
          "Item is removed from list",
        ],
      },
      codeQuality: {
        weight: 25,
        criteria: [
          "Uses memo for list items",
          "Proper TypeScript types",
          "Clean component structure",
        ],
      },
      efficiency: {
        weight: 20,
        criteria: [
          "Uses keyExtractor",
          "Implements getItemLayout",
          "Avoids unnecessary re-renders",
        ],
      },
      bestPractices: {
        weight: 15,
        criteria: [
          "Uses Reanimated 3 API",
          "Accessibility labels present",
          "Handles empty list state",
        ],
      },
    },
    validators: [
      { type: "ast", config: { mustContain: ["FlatList", "useAnimatedStyle", "Gesture"] } },
    ],
    expectedTokens: 1000,
    timeLimit: 150,
  },
  {
    id: "RN002",
    name: "Bottom Sheet with Snap Points",
    category: "react-native",
    difficulty: "medium",
    description: "Implement a draggable bottom sheet with multiple snap points",
    task: `Create a bottom sheet component that:
1. Has 3 snap points (collapsed, half, full)
2. Can be dragged between positions
3. Has a handle for grabbing
4. Includes backdrop that dims based on position
5. Supports keyboard avoidance`,
    expectedBehavior: "Sheet snaps to points, drags smoothly, backdrop dims proportionally",
    fixture: "fixtures/react-native/RN002-bottom-sheet.tsx",
    rubric: {
      correctness: {
        weight: 40,
        criteria: [
          "Sheet renders at initial snap point",
          "Dragging changes position",
          "Snapping to points works",
          "Backdrop visibility changes",
        ],
      },
      codeQuality: {
        weight: 25,
        criteria: [
          "Reusable component API",
          "Props for customization",
          "Internal state management",
        ],
      },
      efficiency: {
        weight: 20,
        criteria: [
          "Uses worklets for animations",
          "Minimal JS thread work",
          "Efficient gesture handling",
        ],
      },
      bestPractices: {
        weight: 15,
        criteria: [
          "Uses GestureDetector",
          "Implements proper haptics",
          "Handles safe areas",
        ],
      },
    },
    validators: [
      { type: "ast", config: { mustContain: ["useSharedValue", "withSpring", "GestureDetector"] } },
    ],
    expectedTokens: 1200,
    timeLimit: 180,
  },
  {
    id: "RN003",
    name: "Expo Camera with Permissions",
    category: "react-native",
    difficulty: "hard",
    description: "Implement camera functionality with proper permission handling",
    task: `Create an Expo camera screen that:
1. Requests camera permissions properly
2. Shows live camera preview
3. Allows taking photos
4. Saves photos to camera roll
5. Handles permission denied gracefully
6. Switches between front/back camera`,
    expectedBehavior: "Camera works, photos save, permissions handled correctly",
    fixture: "fixtures/react-native/RN003-camera.tsx",
    rubric: {
      correctness: {
        weight: 40,
        criteria: [
          "Permission request works",
          "Camera preview shows",
          "Photo capture works",
          "Photo saves to device",
        ],
      },
      codeQuality: {
        weight: 25,
        criteria: [
          "Clean permission flow",
          "Error boundaries for camera",
          "TypeScript types for refs",
        ],
      },
      efficiency: {
        weight: 20,
        criteria: [
          "Camera unmounts properly",
          "No memory leaks",
          "Efficient preview rendering",
        ],
      },
      bestPractices: {
        weight: 15,
        criteria: [
          "Uses expo-camera",
          "Handles background state",
          "Provides permission rationale",
        ],
      },
    },
    validators: [
      { type: "ast", config: { mustContain: ["useCameraPermissions", "CameraView", "takePictureAsync"] } },
    ],
    expectedTokens: 1400,
    timeLimit: 240,
  },
];

export default reactNativeBenchmarks;
