import { create } from 'zustand';

interface User {
  id: string;
  username: string;
  email: string;
  displayName: string;
  phone?: string;
  departmentId?: string;
  roles: string[];
  permissions: string[];
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (data: any) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  updateUser: (user: Partial<User>) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: null,
  isAuthenticated: false,
  isLoading: false,

  checkAuth: async () => {
    const result = await window.api.authCheck();
    if (result.authenticated && result.user) {
      set({ 
        isAuthenticated: true, 
        user: result.user,
        token: localStorage.getItem('authToken')
      });
    }
  },

  login: async (username: string, password: string) => {
    set({ isLoading: true });
    try {
      const result = await window.api.userLogin({ username, password });
      
      if (!result.success) {
        throw new Error(result.error);
      }

      const { user, tokens } = result.data;
      localStorage.setItem('authToken', tokens.accessToken);
      localStorage.setItem('refreshToken', tokens.refreshToken);
      
      await window.api.authSaveToken(tokens.accessToken);

      set({
        isAuthenticated: true,
        user,
        token: tokens.accessToken,
        isLoading: false
      });
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  register: async (data: any) => {
    set({ isLoading: true });
    try {
      const result = await window.api.userRegister(data);
      
      if (!result.success) {
        throw new Error(result.error);
      }

      const { user, tokens } = result.data;
      localStorage.setItem('authToken', tokens.accessToken);
      
      set({
        isAuthenticated: true,
        user,
        token: tokens.accessToken,
        isLoading: false
      });
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  logout: async () => {
    await window.api.authClear();
    localStorage.removeItem('authToken');
    localStorage.removeItem('refreshToken');
    
    set({
      user: null,
      token: null,
      isAuthenticated: false
    });
  },

  updateUser: (userData: Partial<User>) => {
    set((state) => ({
      user: state.user ? { ...state.user, ...userData } : null
    }));
  }
}));
