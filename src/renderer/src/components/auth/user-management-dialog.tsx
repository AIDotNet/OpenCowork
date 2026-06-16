import React, { useState } from 'react';
import { 
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import { Separator } from '../ui/separator';
import { 
  User, 
  Mail, 
  Phone, 
  Building2, 
  Shield, 
  LogOut, 
  Save, 
  X,
  Edit3,
  Loader2
} from 'lucide-react';
import { useAuthStore } from '../../stores/auth-store';

interface UserManagementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const UserManagementDialog: React.FC<UserManagementDialogProps> = ({ 
  open, 
  onOpenChange 
}) => {
  const { user, logout, updateUser, isLoading } = useAuthStore();
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState({
    displayName: user?.displayName || '',
    email: user?.email || '',
    phone: user?.phone || ''
  });

  const handleLogout = async () => {
    await logout();
    onOpenChange(false);
  };

  const handleEdit = () => {
    setFormData({
      displayName: user?.displayName || '',
      email: user?.email || '',
      phone: user?.phone || ''
    });
    setIsEditing(true);
  };

  const handleCancel = () => {
    setIsEditing(false);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // 调用后端 API 更新用户信息
      const result = await window.api.userUpdate(user?.id as any, {
        displayName: formData.displayName,
        email: formData.email,
        phone: formData.phone
      });

      if (result.success) {
        // 更新本地状态
        updateUser({
          displayName: formData.displayName,
          email: formData.email,
          phone: formData.phone
        });
        setIsEditing(false);
      } else {
        console.error('Failed to update user:', result.error);
      }
    } catch (error) {
      console.error('Error updating user:', error);
    } finally {
      setIsSaving(false);
    }
  };

  if (!user) return null;

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="size-5" />
            用户管理
          </DialogTitle>
          <DialogDescription>
            查看和管理您的账户信息
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* User Profile Header */}
          <div className="flex items-center gap-4">
            <Avatar className="size-16">
              <AvatarImage src={user.avatarUrl} alt={user.displayName} />
              <AvatarFallback className="text-lg font-semibold">
                {getInitials(user.displayName || user.username)}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 space-y-1">
              <h3 className="text-lg font-semibold text-foreground">
                {user.displayName || user.username}
              </h3>
              <p className="text-sm text-muted-foreground">@{user.username}</p>
              <div className="flex gap-2">
                {user.roles?.map((role) => (
                  <Badge key={role} variant="secondary" className="text-xs">
                    {role === 'admin' ? '管理员' : role === 'user' ? '普通用户' : role}
                  </Badge>
                ))}
              </div>
            </div>
          </div>

          <Separator />

          {/* User Information */}
          {!isEditing ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-sm">
                <User className="size-4 text-muted-foreground" />
                <span className="font-medium">用户名:</span>
                <span className="text-muted-foreground">{user.username}</span>
              </div>
              
              <div className="flex items-center gap-3 text-sm">
                <Mail className="size-4 text-muted-foreground" />
                <span className="font-medium">邮箱:</span>
                <span className="text-muted-foreground">{user.email}</span>
              </div>

              <div className="flex items-center gap-3 text-sm">
                <Building2 className="size-4 text-muted-foreground" />
                <span className="font-medium">姓名:</span>
                <span className="text-muted-foreground">{user.displayName || '-'}</span>
              </div>

              <div className="flex items-center gap-3 text-sm">
                <Phone className="size-4 text-muted-foreground" />
                <span className="font-medium">手机:</span>
                <span className="text-muted-foreground">{user.phone || '-'}</span>
              </div>

              {user.departmentId && (
                <div className="flex items-center gap-3 text-sm">
                  <Building2 className="size-4 text-muted-foreground" />
                  <span className="font-medium">部门:</span>
                  <span className="text-muted-foreground">{user.departmentId}</span>
                </div>
              )}

              <div className="flex items-center gap-3 text-sm">
                <Shield className="size-4 text-muted-foreground" />
                <span className="font-medium">权限:</span>
                <span className="text-muted-foreground">
                  {user.permissions?.length || 0} 项
                </span>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">用户名</label>
                <Input
                  value={user.username}
                  disabled
                  className="bg-muted"
                />
                <p className="text-xs text-muted-foreground">用户名不可修改</p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">邮箱</label>
                <Input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="your@email.com"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">姓名</label>
                <Input
                  value={formData.displayName}
                  onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                  placeholder="请输入姓名"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">手机号</label>
                <Input
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  placeholder="请输入手机号"
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {!isEditing ? (
            <>
              <Button
                variant="outline"
                onClick={handleLogout}
                disabled={isLoading}
                className="gap-2"
              >
                <LogOut className="size-4" />
                注销登录
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  关闭
                </Button>
                <Button
                  onClick={handleEdit}
                  className="gap-2"
                >
                  <Edit3 className="size-4" />
                  编辑资料
                </Button>
              </div>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={handleCancel}
                disabled={isSaving}
                className="gap-2"
              >
                <X className="size-4" />
                取消
              </Button>
              <Button
                onClick={handleSave}
                disabled={isSaving}
                className="gap-2"
              >
                {isSaving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                {isSaving ? '保存中...' : '保存修改'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
