import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { useAuthStore } from '../../stores/auth-store';
import { RefreshCw } from 'lucide-react';

interface UserDebugDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const UserDebugDialog: React.FC<UserDebugDialogProps> = ({ open, onOpenChange }) => {
  const { user, isAuthenticated, token, checkAuth } = useAuthStore();

  const handleRefresh = async () => {
    await checkAuth();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>用户状态调试信息</DialogTitle>
          <DialogDescription>
            用于诊断用户菜单不显示的问题
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="rounded-lg border p-4 space-y-2">
            <h3 className="font-semibold text-sm">认证状态</h3>
            <div className="text-sm space-y-1">
              <p><span className="font-medium">isAuthenticated:</span> {String(isAuthenticated)}</p>
              <p><span className="font-medium">token:</span> {token ? `${token.slice(0, 20)}...` : 'null'}</p>
              <p><span className="font-medium">localStorage authToken:</span> {localStorage.getItem('authToken') ? '存在' : '不存在'}</p>
            </div>
          </div>

          <div className="rounded-lg border p-4 space-y-2">
            <h3 className="font-semibold text-sm">用户信息</h3>
            {user ? (
              <div className="text-sm space-y-1">
                <p><span className="font-medium">ID:</span> {user.id}</p>
                <p><span className="font-medium">用户名:</span> {user.username}</p>
                <p><span className="font-medium">邮箱:</span> {user.email}</p>
                <p><span className="font-medium">显示名:</span> {user.displayName}</p>
                <p><span className="font-medium">角色:</span> {user.roles?.join(', ') || '无'}</p>
                <p><span className="font-medium">权限数:</span> {user.permissions?.length || 0}</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">用户对象为 null</p>
            )}
          </div>

          <div className="rounded-lg border p-4 space-y-2">
            <h3 className="font-semibold text-sm">操作</h3>
            <Button onClick={handleRefresh} className="gap-2">
              <RefreshCw className="size-4" />
              刷新认证状态
            </Button>
          </div>

          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <h3 className="font-semibold text-sm text-destructive mb-2">
              如果在侧边栏底部看不到用户菜单
            </h3>
            <ul className="text-sm space-y-1 text-muted-foreground">
              <li>1. 检查侧边栏是否被折叠(鼠标悬停展开)</li>
              <li>2. 滚动到侧边栏最底部</li>
              <li>3. 按 Ctrl+R 刷新应用</li>
              <li>4. 如果还是看不到,请截图发给我</li>
            </ul>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => onOpenChange(false)}>关闭</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
