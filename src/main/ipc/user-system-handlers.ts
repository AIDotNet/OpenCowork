import { ipcMain } from 'electron';
import { readSettings } from './settings-handlers';

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

function getServerUrl(): string {
  const envUrl = process.env.MAIN_VITE_SERVER_URL?.trim()
  if (envUrl) return envUrl
  const settings = readSettings()
  return (settings.serverUrl as string) || 'http://localhost:3002'
}

async function apiRequest(endpoint: string, options?: RequestInit): Promise<ApiResponse> {
  const settings = readSettings();
  const serverUrl = getServerUrl();
  const token = settings.authToken;

  try {
    const response = await fetch(`${serverUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...options?.headers
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        success: false,
        error: data.error || '请求失败'
      };
    }

    return {
      success: true,
      data: data.data
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || '网络错误'
    };
  }
}

export function registerUserSystemHandlers(): void {
  // 登录
  ipcMain.handle('user:login', async (_event, credentials: { username: string; password: string }) => {
    const { username, password } = credentials;
    return apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
  });

  // 注册
  ipcMain.handle('user:register', async (_event, data: {
    username: string;
    password: string;
    realName?: string;
    email?: string;
    phone?: string;
    departmentId?: number;
  }) => {
    // 映射前端字段到后端字段
    const backendData = {
      username: data.username,
      email: data.email || data.username,
      password: data.password,
      displayName: data.realName,
      phone: data.phone
    };
    
    return apiRequest('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(backendData)
    });
  });

  // 获取用户信息
  ipcMain.handle('user:getProfile', async () => {
    return apiRequest('/api/users/profile');
  });

  // 获取用户列表
  ipcMain.handle('user:list', async (_event, filters?: {
    departmentId?: string;
    status?: string;
    search?: string;
  }) => {
    const params = new URLSearchParams();
    if (filters?.departmentId) params.set('departmentId', filters.departmentId);
    if (filters?.status) params.set('status', filters.status);
    if (filters?.search) params.set('search', filters.search);

    return apiRequest(`/api/users?${params.toString()}`);
  });

  // 创建用户
  ipcMain.handle('user:create', async (_event, data: any) => {
    return apiRequest('/api/users', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  });

  // 更新用户
  ipcMain.handle('user:update', async (_event, userId: string, data: any) => {
    return apiRequest(`/api/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  });

  // 删除用户
  ipcMain.handle('user:delete', async (_event, userId: string) => {
    return apiRequest(`/api/users/${userId}`, {
      method: 'DELETE'
    });
  });

  // 分配角色
  ipcMain.handle('user:assignRoles', async (_event, userId: string, roleIds: string[]) => {
    return apiRequest(`/api/users/${userId}/roles`, {
      method: 'POST',
      body: JSON.stringify({ roleIds })
    });
  });

  // 获取部门列表
  ipcMain.handle('department:list', async () => {
    return apiRequest('/api/departments');
  });

  // 获取部门树
  ipcMain.handle('department:getTree', async () => {
    return apiRequest('/api/departments/tree');
  });

  // 创建部门
  ipcMain.handle('department:create', async (_event, data: any) => {
    return apiRequest('/api/departments', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  });

  // 更新部门
  ipcMain.handle('department:update', async (_event, deptId: string, data: any) => {
    return apiRequest(`/api/departments/${deptId}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  });

  // 删除部门
  ipcMain.handle('department:delete', async (_event, deptId: string) => {
    return apiRequest(`/api/departments/${deptId}`, {
      method: 'DELETE'
    });
  });

  // 获取角色列表
  ipcMain.handle('role:list', async () => {
    return apiRequest('/api/roles');
  });

  // 获取权限列表
  ipcMain.handle('role:permissions', async () => {
    return apiRequest('/api/roles/permissions');
  });

  // 创建角色
  ipcMain.handle('role:create', async (_event, data: any) => {
    return apiRequest('/api/roles', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  });

  // 更新角色
  ipcMain.handle('role:update', async (_event, roleId: string, data: any) => {
    return apiRequest(`/api/roles/${roleId}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  });

  // 删除角色
  ipcMain.handle('role:delete', async (_event, roleId: string) => {
    return apiRequest(`/api/roles/${roleId}`, {
      method: 'DELETE'
    });
  });

  // 分配权限
  ipcMain.handle('role:assignPermissions', async (_event, roleId: string, permissionIds: string[]) => {
    return apiRequest(`/api/roles/${roleId}/permissions`, {
      method: 'POST',
      body: JSON.stringify({ permissionIds })
    });
  });

  // 下载导入模板
  ipcMain.handle('import:downloadTemplate', async () => {
    const settings = readSettings();
    const serverUrl = getServerUrl();
    const token = settings.authToken;

    try {
      const response = await fetch(`${serverUrl}/api/import/template`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        return { success: false, error: '下载失败' };
      }

      const buffer = await response.arrayBuffer();
      return {
        success: true,
        data: Buffer.from(buffer)
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // 导入用户
  ipcMain.handle('import:users', async (_event, fileBuffer: Buffer) => {
    const settings = readSettings();
    const serverUrl = getServerUrl();
    const token = settings.authToken;

    try {
      const formData = new FormData();
      const uint8Array = new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength);
      const blob = new Blob([Buffer.from(uint8Array)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      formData.append('file', blob, 'users.xlsx');

      const response = await fetch(`${serverUrl}/api/import/excel`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData
      });

      const data = await response.json();

      if (!response.ok) {
        return { success: false, error: data.error || '导入失败' };
      }

      return { success: true, data: data.data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // 保存认证信息
  ipcMain.handle('auth:saveToken', async (_event, token: string) => {
    const settings = readSettings();
    settings.authToken = token;
    return { success: true };
  });

  // 清除认证信息
  ipcMain.handle('auth:clear', async () => {
    const settings = readSettings();
    delete settings.authToken;
    delete settings.currentUser;
    return { success: true };
  });

  // 检查认证状态
  ipcMain.handle('auth:check', async () => {
    const settings = readSettings();
    return {
      authenticated: !!settings.authToken,
      user: settings.currentUser || null
    };
  });
}
