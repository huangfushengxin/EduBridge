import unittest

from math_service.verifier import verify_batch


def tree(op, left, right):
    return {"op": op, "args": [left, right]}


def domain(lower=None, upper=None, lower_closed=False, upper_closed=False, exclude=None):
    return {"lower": lower, "upper": upper, "lower_closed": lower_closed,
            "upper_closed": upper_closed, "exclude": exclude or []}


class VerificationTests(unittest.TestCase):
    def check(self, claim, status, code=None):
        result = verify_batch([claim])
        self.assertEqual(result["status"], status, result)
        if code:
            self.assertEqual(result["code"], code)

    def test_set_operations(self):
        for op, expected in (("union", [1, 2, 3]), ("intersection", [2]), ("difference", [1])):
            with self.subTest(op=op):
                claim = {"kind": "set", "op": op, "left": [1, 2], "right": [2, 3], "expected": expected}
                self.check(claim, "passed")
                self.check({**claim, "expected": [9]}, "failed")

    def test_removable_discontinuity(self):
        expression = tree("div", tree("sub", tree("pow", "x", 2), 1), tree("sub", "x", 1))
        claim = {"kind": "equivalent", "left": expression, "right": tree("add", "x", 1), "domain": domain()}
        self.check(claim, "failed", "domain_contains_undefined_point")
        self.check({**claim, "domain": domain(exclude=[1])}, "passed")

    def test_equation_checks_declared_domain(self):
        claim = {"kind": "equation", "left": tree("pow", "x", 2), "right": 4, "relation": "eq",
                 "domain": domain(0), "expected": [2]}
        self.check(claim, "passed")
        self.check({**claim, "expected": [-2, 2]}, "failed")

    def test_rational_inequality(self):
        positive_segment = domain(0, 1, upper_closed=True)
        claim = {"kind": "inequality", "left": tree("add", "x", tree("div", 4, "x")), "right": 5, "relation": "ge",
                 "domain": positive_segment, "expected": positive_segment}
        self.check(claim, "passed")
        self.check({**claim, "domain": domain(0, 1, True, True)}, "failed", "domain_contains_undefined_point")

    def test_amgm_and_equality_attainability(self):
        claim = {"kind": "amgm2", "a": 1, "b": 4, "claimed_lower": 4, "equality_x": 2,
                 "domain": domain(1, 3, True, True)}
        self.check(claim, "passed")
        self.check({**claim, "domain": domain(0, 1, False, True)}, "failed", "equality_unreachable")
        self.check({**claim, "domain": domain(0, 2)}, "failed", "equality_unreachable")
        self.check({**claim, "domain": domain(-1, 3)}, "failed", "positivity_condition_missing")
        self.check({**claim, "claimed_lower": 5}, "failed")

    def test_unsupported_shape(self):
        self.check({"kind": "natural_language"}, "unsupported", "claim_kind_unsupported")
        self.check({"kind": "equivalent", "left": "sin(x)", "right": "x", "domain": domain()}, "unsupported")
        base = tree("add", "x", 1)
        large = tree("pow", tree("pow", base, 6), 6)
        self.check({"kind": "equivalent", "left": large, "right": 0, "domain": domain()}, "unsupported", "expression_complexity_limit")

    def test_combined_result_never_promotes_unsupported(self):
        result = verify_batch([
            {"kind": "set", "op": "union", "left": [1], "right": [2], "expected": [1, 2]},
            {"kind": "natural_language"},
        ])
        self.assertEqual(result["status"], "unsupported")


if __name__ == "__main__":
    unittest.main()
