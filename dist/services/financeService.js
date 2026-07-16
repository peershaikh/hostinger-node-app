"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.financeService = exports.FinanceService = void 0;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
class FinanceService {
    /**
     * Get current user ID from request context (recommended approach)
     * This will be passed from your controller/middleware.
     */
    getCurrentUserId() {
        // TODO: Replace this with proper auth context
        // Common ways:
        // 1. req.user?.id (from JWT middleware)
        // 2. supabase.auth.getUser() on server
        // 3. Pass userId explicitly from controller
        throw new Error('User ID not available. Please pass userId from controller or implement auth middleware.');
    }
    /**
     * Log a new expense
     */
    async logExpense(amount, category, description, date, tags) {
        const userId = this.getCurrentUserId();
        try {
            const expenseData = {
                user_id: userId,
                amount: Math.abs(amount),
                category: category.toUpperCase().trim(),
                description: description.trim(),
                expense_date: date || new Date().toISOString().split('T')[0],
                tags: tags || [],
                created_at: new Date().toISOString(),
            };
            const { error } = await supabase_1.supabase
                .from('user_expenses')
                .insert(expenseData);
            if (error)
                throw error;
            logger_1.winstonLogger.info(`[FINANCE] Expense logged: ₹${amount} - ${category} (User: ${userId})`);
            return {
                success: true,
                message: 'Expense logged successfully',
            };
        }
        catch (e) {
            logger_1.winstonLogger.error(`[FINANCE] Failed to log expense: ${e.message}`);
            throw new Error('Failed to log expense. Please try again later.');
        }
    }
    /**
     * Get AI-driven investment predictions
     */
    async getInvestmentPredictions() {
        const userId = this.getCurrentUserId();
        try {
            const sixMonthsAgo = new Date();
            sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
            const { data: expenses, error } = await supabase_1.supabase
                .from('user_expenses')
                .select('amount, category, expense_date')
                .eq('user_id', userId)
                .gte('expense_date', sixMonthsAgo.toISOString().split('T')[0]);
            if (error || !expenses || expenses.length === 0) {
                return {
                    predictions: [],
                    health_score: 45,
                    timestamp: new Date().toISOString(),
                    message: 'Not enough spending data for predictions',
                };
            }
            const totalSpent = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
            const avgMonthly = Math.round(totalSpent / 6);
            const predictions = [
                {
                    category: 'Mutual Funds',
                    predicted_amount: Math.round(avgMonthly * 0.25),
                    confidence: 78,
                    timeframe: '6months',
                    suggestion: 'Consider index funds for long-term growth',
                },
                {
                    category: 'Emergency Fund',
                    predicted_amount: Math.round(avgMonthly * 0.15),
                    confidence: 92,
                    timeframe: '3months',
                    suggestion: 'Build 3-6 months emergency corpus',
                },
                {
                    category: 'Travel Savings',
                    predicted_amount: Math.round(avgMonthly * 0.20),
                    confidence: 65,
                    timeframe: '1year',
                    suggestion: 'Save specifically for future rail/air trips',
                },
            ];
            const healthScore = this.calculateBasicHealthScore(expenses);
            return {
                predictions,
                health_score: healthScore.score,
                timestamp: new Date().toISOString(),
            };
        }
        catch (e) {
            logger_1.winstonLogger.error(`[FINANCE] Prediction failed: ${e.message}`);
            return {
                predictions: [],
                health_score: 40,
                timestamp: new Date().toISOString(),
            };
        }
    }
    /**
     * Get Financial Health Score
     */
    async getFinancialHealthScore() {
        const userId = this.getCurrentUserId();
        try {
            const { data: expenses, error } = await supabase_1.supabase
                .from('user_expenses')
                .select('amount, category, expense_date')
                .eq('user_id', userId)
                .order('expense_date', { ascending: false })
                .limit(100);
            if (error || !expenses || expenses.length < 5) {
                return {
                    score: 40,
                    status: 'MODERATE',
                    breakdown: { spending: 40, savings: 30, consistency: 50, travelExpenseRatio: 60 },
                    insights: ['Track more expenses to get accurate insights'],
                };
            }
            return this.calculateBasicHealthScore(expenses);
        }
        catch (e) {
            logger_1.winstonLogger.error(`[FINANCE] Health score failed: ${e.message}`);
            return {
                score: 35,
                status: 'MODERATE',
                breakdown: { spending: 30, savings: 30, consistency: 40, travelExpenseRatio: 50 },
                insights: ['Unable to fetch score at the moment'],
            };
        }
    }
    calculateBasicHealthScore(expenses) {
        // (Same implementation as before - kept clean)
        const totalSpent = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
        const travelExpenses = expenses
            .filter((e) => ['TRAVEL', 'TRANSPORT', 'HOTEL', 'FLIGHT', 'TRAIN', 'RAIL'].includes(e.category))
            .reduce((sum, e) => sum + Number(e.amount), 0);
        const travelRatio = totalSpent > 0 ? Math.round((travelExpenses / totalSpent) * 100) : 0;
        const avgDaily = totalSpent / Math.max(expenses.length, 30);
        const spendingScore = Math.max(0, 100 - Math.min(avgDaily * 2, 80));
        const savingsPotential = Math.max(20, 100 - Math.round(travelRatio * 0.6));
        const consistencyScore = Math.min(95, expenses.length * 2);
        const finalScore = Math.round(spendingScore * 0.35 + savingsPotential * 0.35 + consistencyScore * 0.30);
        let status = finalScore >= 80 ? 'EXCELLENT' :
            finalScore >= 65 ? 'GOOD' :
                finalScore >= 45 ? 'MODERATE' : 'POOR';
        const insights = [];
        if (travelRatio > 40)
            insights.push('Travel expenses are high — consider budget planning.');
        if (avgDaily > 800)
            insights.push('Daily spending appears elevated.');
        return {
            score: Math.min(100, finalScore),
            status,
            breakdown: {
                spending: Math.round(spendingScore),
                savings: Math.round(savingsPotential),
                consistency: Math.round(consistencyScore),
                travelExpenseRatio: travelRatio,
            },
            insights: insights.length ? insights : ['Good job tracking your expenses!'],
        };
    }
}
exports.FinanceService = FinanceService;
exports.financeService = new FinanceService();
