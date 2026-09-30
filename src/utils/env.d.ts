// Ambient type declarations for browser APIs that are missing or
// experimental in TypeScript's bundled lib.dom.

// Experimental File System Observer API
interface FileSystemObserverRecord {
  relativePathComponents: string[];
  type: string;
}

type FileSystemObserverCallback = (records: FileSystemObserverRecord[]) => void;

declare class FileSystemObserver {
  constructor(callback: FileSystemObserverCallback);
  observe(
    handle: FileSystemDirectoryHandle,
    options?: { recursive: boolean },
  ): Promise<void>;
  disconnect(): void;
}

// Permission descriptors (not present in all lib.dom versions)
interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

// showDirectoryPicker on Window
interface Window {
  showDirectoryPicker(options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
  }): Promise<FileSystemDirectoryHandle>;
  fs: any;
}

// FileSystemDirectoryHandle.values() returns AsyncIterableIterator
interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

// Custom events dispatched by WebFileSystem on the terminal root element.
interface HTMLElementEventMap {
  "fs:init": CustomEvent<unknown>;
  "fs:modified": CustomEvent<{ path?: string }>;
}

// picomatch ships no type declarations.
declare module "picomatch";
