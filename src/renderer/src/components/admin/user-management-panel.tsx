import React, { useState, useEffect } from 'react';
import { useAuthStore } from '../../stores/auth-store';

interface User {
  id: string;
  username: string;
  email: string;
  display_name: string;
  phone: string;
  department_id: string;
  department_name: string;
  status: string;
  roles: Array<{ id: string; name: string; code: string }>;
}

interface Department {
  id: string;
  name: string;
  code: string;
  manager_name: string;
  user_count: number;
}

interface Role {
  id: string;
  name: string;
  code: string;
  description: string;
  permissions: Array<{ id: string; name: string; code: string }>;
}

export const UserManagementPanel: React.FC = () => {
  const { user: currentUser } = useAuthStore();
  const [users, setUsers] = useState<User[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [activeTab, setActiveTab] = useState<'users' | 'departments' | 'roles'>('users');
  const [searchTerm, setSearchTerm] = useState('');

  const loadData = async () => {
    try {
      const [usersRes, deptsRes, rolesRes] = await Promise.all([
        window.api.userList(),
        window.api.departmentList(),
        window.api.roleList()
      ]);

      if (usersRes.success) setUsers(usersRes.data);
      if (deptsRes.success) setDepartments(deptsRes.data);
      if (rolesRes.success) setRoles(rolesRes.data);
    } catch (error) {
      console.error('加载数据失败:', error);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const filteredUsers = users.filter(u =>
    u.username.toLowerCase().includes(searchTerm.toLowerCase()) ||
    u.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
    u.display_name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (!currentUser?.roles.includes('admin')) {
    return (
      <div className="p-8 text-center text-gray-500 dark:text-gray-400">
        您没有权限访问此页面
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">用户与权限管理</h1>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="-mb-px flex space-x-8">
          {[
            { key: 'users' as const, label: '用户管理' },
            { key: 'departments' as const, label: '部门管理' },
            { key: 'roles' as const, label: '角色权限' }
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === tab.key
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Users Tab */}
      {activeTab === 'users' && (
        <div className="space-y-4">
          <div className="flex gap-4">
            <input
              type="text"
              placeholder="搜索用户..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md dark:bg-gray-700 dark:text-white"
            />
            <button
              onClick={loadData}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              刷新
            </button>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">用户名</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">邮箱</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">姓名</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">部门</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">角色</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {filteredUsers.map(user => (
                  <tr key={user.id}>
                    <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">{user.username}</td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{user.email}</td>
                    <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">{user.display_name}</td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{user.department_name || '-'}</td>
                    <td className="px-6 py-4 text-sm">
                      <div className="flex gap-1 flex-wrap">
                        {user.roles.map(role => (
                          <span key={role.id} className="px-2 py-1 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded text-xs">
                            {role.name}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm">
                      <span className={`px-2 py-1 rounded text-xs ${
                        user.status === 'active' 
                          ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                          : 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200'
                      }`}>
                        {user.status === 'active' ? '活跃' : '禁用'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Departments Tab */}
      {activeTab === 'departments' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {departments.map(dept => (
            <div key={dept.id} className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">{dept.name}</h3>
              <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
                <p>编码: {dept.code}</p>
                <p>经理: {dept.manager_name || '未设置'}</p>
                <p>人数: {dept.user_count}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Roles Tab */}
      {activeTab === 'roles' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {roles.map(role => (
            <div key={role.id} className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">{role.name}</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">{role.description}</p>
              <div className="space-y-2">
                <p className="text-xs font-medium text-gray-500 uppercase">权限:</p>
                <div className="flex gap-1 flex-wrap">
                  {role.permissions.map(perm => (
                    <span key={perm.id} className="px-2 py-1 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded text-xs">
                      {perm.name}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
