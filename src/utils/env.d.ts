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