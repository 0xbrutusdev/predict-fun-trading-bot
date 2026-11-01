import unittest
from research.evaluate import evaluate

class ReportTests(unittest.TestCase):
    def test_missing_days_and_epoch_zero(self):
        result=evaluate([{'time':86400000,'settled_at':0,'pnl':1000000},
                         {'time':172800000,'settled_at':172800000,'pnl':2000000}],100)
        self.assertEqual(result['days'],3)
        self.assertEqual(result['mean_daily_pnl'],1)

    def test_unresolved_not_counted_as_losses(self):
        self.assertEqual(evaluate([{'time':0,'pnl':None}])['unresolved'],1)

if __name__=='__main__':
    unittest.main()
